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
    const meta = await SHEETS.spreadsheets.get({
      spreadsheetId,
      auth,
    });
    const sheet = meta.data.sheets[0];
    const rowCount = sheet.properties.gridProperties.rowCount;
    if (rowCount <= 1) return [];

    const response = await SHEETS.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A2:K",
      auth,
    });

    const rows = response.data.values || [];
    const suspicious = rows.filter((row) => row.length < 11);
    if (suspicious.length > 0) {
      console.warn(
        `⚠️ [Sheets] ${suspicious.length} rows có < 11 cột — likely cause of false duplicates`,
      );
    }

    return rows.map((row, index) => {
      // Pad row to ensure all 11 columns exist regardless of trailing empty cells
      const r = Array.from({ length: 11 }, (_, i) => row[i] || "");
      return {
        rowIndex: index + 2,
        goodreadsCheck: r[0],
        goodreadsId: r[1],
        title: r[2],
        author: r[3],
        year: r[4],
        rating: r[5],
        ratingCount: r[6],
        cover: r[7],
        source: r[8],
        size: r[9],
        location: r[10],
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
  const books = existingBooks || (await getAllBooks(spreadsheetId));
  const existingIndex = books.findIndex(
    (b) => b.location === bookData.location,
  );

  const rowValues = [
    bookData.goodreadsCheck || "No",
    bookData.goodreadsId || "",
    bookData.title || "",
    bookData.author || "",
    bookData.year || "",
    bookData.rating || "",
    bookData.ratingCount || "",
    bookData.cover || "",
    bookData.source || "",
    bookData.size || "",
    bookData.location || "",
  ];

  try {
    if (existingIndex !== -1) {
      const existingBook = books[existingIndex];

      await SHEETS.spreadsheets.values.update({
        spreadsheetId,
        range: `Sheet1!A${existingBook.rowIndex}:K${existingBook.rowIndex}`,
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

module.exports = { setupHeaders, getAllBooks, addOrUpdateBook, deleteBooks };
