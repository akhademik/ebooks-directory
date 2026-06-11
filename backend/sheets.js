const { google } = require("googleapis");
require("dotenv").config();

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

async function getAuthClient() {
  if (
    !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !process.env.GOOGLE_PRIVATE_KEY
  ) {
    throw new Error("Missing Google Service Account credentials in .env");
  }

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n").replace(/"/g, ""),
    scopes: SCOPES,
  });
  return auth;
}

const SHEETS = google.sheets("v4");

/**
 * Gets the column mapping from headers.
 * Returns an object with indices for each required field.
 */
async function getColumnMapping(spreadsheetId, auth) {
  const defaultMapping = {
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

  try {
    const response = await SHEETS.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:Z1",
      auth,
    });

    const headers = response.data.values?.[0];
    if (!headers || headers.length === 0) return defaultMapping;

    const mapping = { ...defaultMapping };
    const headerMap = {
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

    headers.forEach((h, i) => {
      const cleanHeader = h.trim();
      if (headerMap[cleanHeader]) {
        mapping[headerMap[cleanHeader]] = i;
      }
    });

    return mapping;
  } catch (error) {
    console.error("[Sheets Mapping Error]", error.message);
    return defaultMapping;
  }
}

async function setupHeaders(spreadsheetId) {
  const auth = await getAuthClient();
  const headers = [
    "Goodreads Check",
    "Goodreads ID",
    "Title",
    "Author",
    "Year",
    "Rating",
    "Number of user rating",
    "Cover URL",
    "Source",
    "File Size",
    "Location",
  ];

  try {
    const response = await SHEETS.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:K1",
      auth,
    });

    if (!response.data.values || response.data.values[0].length === 0) {
      await SHEETS.spreadsheets.values.update({
        spreadsheetId,
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        resource: { values: [headers] },
        auth,
      });
      console.log("[Sheets] Headers created.");
    }
  } catch (error) {
    console.error("[Sheets Setup Error]", error.message);
  }
}

async function getAllBooks(spreadsheetId) {
  const auth = await getAuthClient();
  try {
    const mapping = await getColumnMapping(spreadsheetId, auth);
    const maxIndex = Math.max(...Object.values(mapping));
    // Convert index to A-Z column notation (supports up to Z)
    const rangeEndColumn = String.fromCharCode(65 + Math.min(25, maxIndex));

    const response = await SHEETS.spreadsheets.values.get({
      spreadsheetId,
      range: `Sheet1!A2:${rangeEndColumn}`,
      auth,
    });

    const rows = response.data.values || [];

    return rows.map((row, index) => {
      const getVal = (idx) => (row[idx] || "").toString().trim();
      const normalizeLoc = (s) =>
        s.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC").trim();
      return {
        rowIndex: index + 2,
        goodreadsCheck: getVal(mapping.goodreadsCheck),
        goodreadsId: getVal(mapping.goodreadsId),
        title: getVal(mapping.title),
        author: getVal(mapping.author),
        year: getVal(mapping.year),
        rating: getVal(mapping.rating),
        ratingCount: getVal(mapping.ratingCount),
        cover: getVal(mapping.cover),
        source: getVal(mapping.source),
        size: getVal(mapping.size),
        location: normalizeLoc(row[mapping.location] || ""),
      };
    });
  } catch (error) {
    if (error.message.includes("exceeds grid limits")) return [];
    console.error("[Sheets Get Error]", error.message);
    return [];
  }
}

async function addOrUpdateBook(spreadsheetId, bookData, existingBooks = null) {
  const auth = await getAuthClient();
  const mapping = await getColumnMapping(spreadsheetId, auth);
  const books = existingBooks || (await getAllBooks(spreadsheetId));

  const normalize = (s) => (s || "").toString().trim().normalize("NFC");
  const targetLocation = normalize(bookData.location);

  const existingIndex = books.findIndex(
    (b) => normalize(b.location) === targetLocation,
  );

  const maxIndex = Math.max(...Object.values(mapping));
  const rowValues = new Array(maxIndex + 1).fill("");
  rowValues[mapping.goodreadsCheck] = bookData.goodreadsCheck || "No";
  rowValues[mapping.goodreadsId] = bookData.goodreadsId || "";
  rowValues[mapping.title] = bookData.title || "";
  rowValues[mapping.author] = bookData.author || "";
  rowValues[mapping.year] = bookData.year || "";
  rowValues[mapping.rating] = bookData.rating || "";
  rowValues[mapping.ratingCount] = bookData.ratingCount || "";
  rowValues[mapping.cover] = bookData.cover || "";
  rowValues[mapping.source] = bookData.source || "";
  rowValues[mapping.size] = bookData.size || "";
  rowValues[mapping.location] = bookData.location || "";

  try {
    if (existingIndex !== -1) {
      const existingBook = books[existingIndex];
      const rangeEndColumn = String.fromCharCode(65 + Math.min(25, maxIndex));

      await SHEETS.spreadsheets.values.update({
        spreadsheetId,
        range: `Sheet1!A${existingBook.rowIndex}:${rangeEndColumn}${existingBook.rowIndex}`,
        valueInputOption: "RAW",
        resource: { values: [rowValues] },
        auth,
      });
      console.log(`[Sheets] Updated: ${bookData.title}`);
    } else {
      await SHEETS.spreadsheets.values.append({
        spreadsheetId,
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        resource: { values: [rowValues] },
        auth,
      });
      console.log(`[Sheets] Added: ${bookData.title}`);
    }
  } catch (error) {
    if (error.message.includes("Quota exceeded")) {
      console.warn(`[Sheets Quota Error] Waiting 60s before retrying...`);
      await new Promise((r) => setTimeout(r, 60000));
      return addOrUpdateBook(spreadsheetId, bookData, existingBooks);
    }
    throw error;
  }
}

/**
 * Batch-inserts many books in a single API call.
 * Fetches the column mapping once, builds all rows, then appends them together.
 * Use this instead of calling addOrUpdateBook in a loop.
 */
async function addBooks(spreadsheetId, booksArray) {
  if (!booksArray || booksArray.length === 0) return;

  const auth = await getAuthClient();
  const mapping = await getColumnMapping(spreadsheetId, auth); // 1 read, only once
  const maxIndex = Math.max(...Object.values(mapping));

  const rows = booksArray.map((bookData) => {
    const row = new Array(maxIndex + 1).fill("");
    row[mapping.goodreadsCheck] = bookData.goodreadsCheck || "No";
    row[mapping.goodreadsId] = bookData.goodreadsId || "";
    row[mapping.title] = bookData.title || "";
    row[mapping.author] = bookData.author || "";
    row[mapping.year] = bookData.year || "";
    row[mapping.rating] = bookData.rating || "";
    row[mapping.ratingCount] = bookData.ratingCount || "";
    row[mapping.cover] = bookData.cover || "";
    row[mapping.source] = bookData.source || "";
    row[mapping.size] = bookData.size || "";
    row[mapping.location] = bookData.location || "";
    return row;
  });

  try {
    await SHEETS.spreadsheets.values.append({
      spreadsheetId,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      resource: { values: rows },
      auth,
    });
    console.log(`[Sheets] Batch-added ${rows.length} books.`);
  } catch (error) {
    if (error.message.includes("Quota exceeded")) {
      console.warn(`[Sheets Quota Error] Waiting 60s before retrying batch...`);
      await new Promise((r) => setTimeout(r, 60000));
      return addBooks(spreadsheetId, booksArray);
    }
    throw error;
  }
}

async function deleteBooks(spreadsheetId, rowIndices) {
  if (!rowIndices || rowIndices.length === 0) return;
  const auth = await getAuthClient();

  // Sort in descending order to avoid index shifting during deletion
  const sortedIndices = [...rowIndices].sort((a, b) => b - a);

  try {
    const requests = sortedIndices.map((index) => ({
      deleteDimension: {
        range: {
          sheetId: 0, // Assuming Sheet1 has ID 0 (default)
          dimension: "ROWS",
          startIndex: index - 1, // 0-based index
          endIndex: index, // exclusive
        },
      },
    }));

    await SHEETS.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests },
      auth,
    });
    console.log(`[Sheets] Deleted ${rowIndices.length} books.`);
  } catch (error) {
    console.error("[Sheets Delete Error]", error.message);
  }
}

module.exports = {
  setupHeaders,
  getAllBooks,
  addOrUpdateBook,
  addBooks,
  deleteBooks,
};
