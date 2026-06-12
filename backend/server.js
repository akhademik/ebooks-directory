const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { fetchAllBooks } = require("./clients/googleSheetsClient");
const createApiRouter = require("./routes/apiRoutes");

const app = express();
app.disable("x-powered-by");

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const BOOKS_PATH = process.env.BOOKS_PATH;

// ─── Shared State ────────────────────────────────────────────────────────────
const state = {
  isScanning: false,
  isEnriching: false,
  isSyncing: false,
  scanResults: { total: 0, processed: 0, added: 0, skipped: 0, deleted: 0, errors: 0 },
  enrichment: { total: 0, current: 0, currentTitle: "" }
};

let cachedBooks = [];
let currentScanId = 0;
let lastSyncPreview = null;

// ─── Helper Contexts ─────────────────────────────────────────────────────────
const cache = {
  async getBooks(forceRefresh = false) {
    if (cachedBooks.length === 0 || forceRefresh) {
      console.log(`[Cache] 🔄 Fetching from Google Sheets...`);
      cachedBooks = await fetchAllBooks(SHEET_ID);
      console.log(`[Cache] ✅ Loaded ${cachedBooks.length} books.`);
    }
    return cachedBooks;
  },
  updateBook(updatedBook) {
    const index = cachedBooks.findIndex((book) => book.location === updatedBook.location);
    if (index !== -1) {
      cachedBooks[index] = { ...cachedBooks[index], ...updatedBook };
    }
  }
};

const scanContext = {
  getScanId: () => currentScanId,
  incrementScanId: () => { currentScanId += 1; },
  getLastSyncPreview: () => lastSyncPreview,
  setLastSyncPreview: (preview) => { lastSyncPreview = preview; },
  clearLastSyncPreview: () => { lastSyncPreview = null; }
};

// ─── Middleware & Routes ─────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const apiRouter = createApiRouter({ state, cache, scanContext });
app.use("/api", apiRouter);

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📚 Scanning path: ${BOOKS_PATH}`);
  console.log(`=========================================`);
});
