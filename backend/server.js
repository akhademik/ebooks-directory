const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { fetchAllBooks } = require("./clients/googleSheetsClient");
const createApiRouter = require("./routes/apiRoutes");
const cacheManager = require("./services/cacheManager.service");
const writeQueue = require("./services/writeQueue.service");

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
  enrichment: { total: 0, current: 0, currentTitle: "" },
  duplicateProgress: { total: 0, current: 0, percent: 0 }
};

let cachedBooks = [];
let currentScanId = 0;
let lastSyncPreview = null;

// ─── Helper Contexts ─────────────────────────────────────────────────────────
const cache = {
  async getBooks(forceRefresh = false) {
    // If we have books in memory and aren't forcing, return them
    if (cachedBooks.length > 0 && !forceRefresh) {
      return cachedBooks;
    }

    console.log(`[Cache] 🔄 Syncing with Google Sheets (Source of Truth)...`);
    try {
      // 1. Always fetch the master list from Sheets
      const sheetBooks = await fetchAllBooks(SHEET_ID);
      
      // 2. Load local cache to preserve filesystem-only metadata (hashes, sizes, etc.)
      const localBooks = await cacheManager.load();
      const localBooksMap = new Map(localBooks.map((book) => [book.location, book]));
      
      // 3. Merge: Every book in Sheets is kept, enriched with local metadata if available
      cachedBooks = sheetBooks.map((sheetBook) => {
        const localBook = localBooksMap.get(sheetBook.location);
        if (localBook) {
          return {
            ...sheetBook,
            // Keep filesystem info from local cache
            size: localBook.size || sheetBook.size,
            extension: localBook.extension || sheetBook.extension,
            fileHash: localBook.fileHash || sheetBook.fileHash,
          };
        }
        return sheetBook;
      });

      // 4. Update the local JSON to match the new reality
      await cacheManager.save(cachedBooks);
      console.log(`[Cache] ✅ Successfully synced ${cachedBooks.length} books from Sheets.`);
    } catch (error) {
      console.error(`[Cache] ❌ Failed to fetch from Google Sheets: ${error.message}`);
      
      // Fallback: If Sheets fails, try to load whatever we have locally
      if (cachedBooks.length === 0) {
        cachedBooks = await cacheManager.load();
        if (cachedBooks.length > 0) {
          console.log(`[Cache] 📂 Fallback: Loaded ${cachedBooks.length} books from local JSON.`);
        }
      }
    }

    return cachedBooks;
  },
  updateBook(updatedBook) {
    const index = cachedBooks.findIndex((book) => book.location === updatedBook.location);
    if (index !== -1) {
      cachedBooks[index] = { ...cachedBooks[index], ...updatedBook };
    }
  },
  async saveBooks() {
    await cacheManager.save(cachedBooks);
  }
};

// Initialize write queue
writeQueue.init({
  sheetId: SHEET_ID,
  onFlushSuccess: async () => {
    await cache.saveBooks();
  },
  onAfterDelete: async () => {
    // Refresh indices after deletion
    await cache.getBooks(true);
  }
});

// Graceful shutdown
const shutdown = async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await writeQueue.shutdown();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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
