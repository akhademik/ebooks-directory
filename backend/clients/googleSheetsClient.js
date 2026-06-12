const { google } = require("googleapis");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const GOOGLE_SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const GOOGLE_SHEETS_API_VERSION = "v4";
const SHEETS_SERVICE = google.sheets(GOOGLE_SHEETS_API_VERSION);

// ─── Column Mapping Cache ───────────────────────────────────────────────────
let columnMappingCache = null;
let lastCacheUpdateTimestamp = 0;
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

const DEFAULT_COLUMN_MAPPING = {
  goodreadsCheck: 0,
  goodreadsId: 1,
  title: 2,
  author: 3,
  year: 4,
  rating: 5,
  ratingCount: 6,
  cover: 7,
  source: 8,
  size: 9,
  location: 10,
};

const HEADER_NAME_TO_KEY_MAP = {
  "Goodreads Check": "goodreadsCheck",
  "Goodreads ID": "goodreadsId",
  Title: "title",
  Author: "author",
  Year: "year",
  Rating: "rating",
  "Number of user rating": "ratingCount",
  "Cover URL": "cover",
  Source: "source",
  "File Size": "size",
  Location: "location",
};

/**
 * Creates an authenticated Google API client.
 */
async function getAuthenticatedClient() {
  const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;

  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    throw new Error("Missing Google Service Account credentials in .env");
  }

  return new google.auth.JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n").replace(/"/g, ""),
    scopes: GOOGLE_SHEETS_SCOPES,
  });
}

/**
 * Fetches headers from the spreadsheet and updates the column mapping cache.
 */
async function refreshColumnMapping(spreadsheetId, auth) {
  try {
    const response = await SHEETS_SERVICE.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:Z1",
      auth,
    });

    const headers = response.data.values?.[0];
    if (!headers || headers.length === 0) return DEFAULT_COLUMN_MAPPING;

    const mapping = { ...DEFAULT_COLUMN_MAPPING };
    headers.forEach((header, index) => {
      const cleanHeader = header.trim();
      const key = HEADER_NAME_TO_KEY_MAP[cleanHeader];
      if (key) {
        mapping[key] = index;
      }
    });

    columnMappingCache = mapping;
    lastCacheUpdateTimestamp = Date.now();
    return mapping;
  } catch (error) {
    console.error(`[GoogleSheetsClient] Error fetching mapping: ${error.message}`);
    return DEFAULT_COLUMN_MAPPING;
  }
}

/**
 * Gets the current column mapping, using cache if available and fresh.
 */
async function getColumnMapping(spreadsheetId, auth) {
  const isCacheFresh = Date.now() - lastCacheUpdateTimestamp < CACHE_DURATION_MS;
  if (columnMappingCache && isCacheFresh) {
    return columnMappingCache;
  }
  return await refreshColumnMapping(spreadsheetId, auth);
}

/**
 * Ensures the spreadsheet has the required headers.
 */
async function setupSpreadsheetHeaders(spreadsheetId) {
  const auth = await getAuthenticatedClient();
  const requiredHeaders = Object.keys(HEADER_NAME_TO_KEY_MAP);

  try {
    const response = await SHEETS_SERVICE.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:K1",
      auth,
    });

    const existingHeaders = response.data.values?.[0] || [];
    if (existingHeaders.length === 0) {
      await SHEETS_SERVICE.spreadsheets.values.update({
        spreadsheetId,
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        resource: { values: [requiredHeaders] },
        auth,
      });
      console.log("[GoogleSheetsClient] Headers initialized.");
    }
  } catch (error) {
    throw new Error(`Failed to setup headers: ${error.message}`, { cause: error });
  }
}

/**
 * Maps a raw row array to a book object based on the column mapping.
 */
function mapRowToBook(row, index, mapping) {
  const getCellValue = (colIndex) => (row[colIndex] || "").toString().trim();
  const normalizePath = (pathString) =>
    (pathString || "").replace(/\\/g, "/").replace(/\/$/, "").normalize("NFC").trim();

  return {
    rowIndex: index + 2, // 1-based index, skipping header
    goodreadsCheck: getCellValue(mapping.goodreadsCheck),
    goodreadsId: getCellValue(mapping.goodreadsId),
    title: getCellValue(mapping.title),
    author: getCellValue(mapping.author),
    year: getCellValue(mapping.year),
    rating: getCellValue(mapping.rating),
    ratingCount: getCellValue(mapping.ratingCount),
    cover: getCellValue(mapping.cover),
    source: getCellValue(mapping.source),
    size: getCellValue(mapping.size),
    location: normalizePath(row[mapping.location]),
  };
}

/**
 * Fetches all books from the spreadsheet.
 */
async function fetchAllBooks(spreadsheetId) {
  const auth = await getAuthenticatedClient();
  try {
    const mapping = await getColumnMapping(spreadsheetId, auth);
    const maxIndex = Math.max(...Object.values(mapping));
    const lastColumnLetter = String.fromCharCode(65 + Math.min(25, maxIndex));

    const response = await SHEETS_SERVICE.spreadsheets.values.get({
      spreadsheetId,
      range: `Sheet1!A2:${lastColumnLetter}`,
      auth,
    });

    const rows = response.data.values || [];
    return rows.map((row, index) => mapRowToBook(row, index, mapping));
  } catch (error) {
    if (error.message.includes("exceeds grid limits")) return [];
    throw new Error(`Failed to fetch books: ${error.message}`, { cause: error });
  }
}

/**
 * Converts a book object to a row array based on column mapping.
 */
function mapBookToRow(bookData, mapping) {
  const maxIndex = Math.max(...Object.values(mapping));
  const row = new Array(maxIndex + 1).fill("");
  
  Object.entries(mapping).forEach(([key, index]) => {
    if (key === "goodreadsCheck") {
      row[index] = bookData[key] || "No";
    } else {
      row[index] = bookData[key] || "";
    }
  });
  
  return row;
}

/**
 * Adds or updates a single book in the spreadsheet.
 */
async function saveBook(spreadsheetId, bookData, existingBooks = null) {
  const auth = await getAuthenticatedClient();
  const mapping = await getColumnMapping(spreadsheetId, auth);
  const books = existingBooks || (await fetchAllBooks(spreadsheetId));

  const targetLocation = (bookData.location || "").toString().trim().normalize("NFC");
  const existingBook = books.find((book) => book.location === targetLocation);
  const rowValues = mapBookToRow(bookData, mapping);

  try {
    if (existingBook) {
      const maxIndex = Math.max(...Object.values(mapping));
      const lastColumnLetter = String.fromCharCode(65 + Math.min(25, maxIndex));
      await SHEETS_SERVICE.spreadsheets.values.update({
        spreadsheetId,
        range: `Sheet1!A${existingBook.rowIndex}:${lastColumnLetter}${existingBook.rowIndex}`,
        valueInputOption: "RAW",
        resource: { values: [rowValues] },
        auth,
      });
    } else {
      await SHEETS_SERVICE.spreadsheets.values.append({
        spreadsheetId,
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        resource: { values: [rowValues] },
        auth,
      });
    }
  } catch (error) {
    if (error.message.includes("Quota exceeded")) {
      await new Promise((resolve) => setTimeout(resolve, 60000));
      return await saveBook(spreadsheetId, bookData, existingBooks);
    }
    throw new Error(`Failed to save book: ${error.message}`, { cause: error });
  }
}

/**
 * Batch-adds multiple books to the spreadsheet.
 */
async function batchAddBooks(spreadsheetId, booksArray) {
  if (!booksArray?.length) return;

  const auth = await getAuthenticatedClient();
  const mapping = await getColumnMapping(spreadsheetId, auth);
  const rows = booksArray.map((book) => mapBookToRow(book, mapping));

  try {
    await SHEETS_SERVICE.spreadsheets.values.append({
      spreadsheetId,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      resource: { values: rows },
      auth,
    });
  } catch (error) {
    if (error.message.includes("Quota exceeded")) {
      await new Promise((resolve) => setTimeout(resolve, 60000));
      return await batchAddBooks(spreadsheetId, booksArray);
    }
    throw new Error(`Failed to batch add books: ${error.message}`, { cause: error });
  }
}

/**
 * Deletes multiple rows from the spreadsheet by their indices.
 */
async function batchDeleteBooks(spreadsheetId, rowIndices) {
  if (!rowIndices?.length) return;
  const auth = await getAuthenticatedClient();

  // Sort descending to avoid index shifting
  const sortedIndices = [...rowIndices].sort((a, b) => b - a);
  const deleteRequests = sortedIndices.map((index) => ({
    deleteDimension: {
      range: {
        sheetId: 0,
        dimension: "ROWS",
        startIndex: index - 1,
        endIndex: index,
      },
    },
  }));

  try {
    await SHEETS_SERVICE.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: deleteRequests },
      auth,
    });
  } catch (error) {
    throw new Error(`Failed to delete books: ${error.message}`, { cause: error });
  }
}

module.exports = {
  setupSpreadsheetHeaders,
  fetchAllBooks,
  saveBook,
  batchAddBooks,
  batchDeleteBooks,
};
