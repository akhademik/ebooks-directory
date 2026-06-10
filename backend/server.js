const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const mime = require("mime-types");
require("dotenv").config();

const { getBookMetadata, getBasicInfo } = require("./scanner");
const {
  setupHeaders,
  getAllBooks,
  addOrUpdateBook,
  deleteBooks,
} = require("./sheets");
const { getPreview } = require("./utils/preview");
const { extractEmbeddedCover } = require("./utils/cover");

const app = express();
app.disable("x-powered-by");
const PORT = process.env.PORT || 3000;
const BOOKS_PATH = process.env.BOOKS_PATH;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const ERR_BOOK_NOT_FOUND = "Book not found";

// ─── Cache & State ────────────────────────────────────────────────────────────
let cachedBooks = [];
let isScanning = false;
let isEnriching = false;
let enrichingScanId = -1; // Track which scanId is currently enriching
let currentScanId = 0; 

let scanResults = {
  total: 0,
  processed: 0,
  added: 0,
  skipped: 0,
  deleted: 0,
  errors: 0,
};
let enrichResults = { total: 0, current: 0, currentTitle: "" };

/**
 * Helper to get books with cache
 */
async function getBooksCached(forceRefresh = false) {
  if (cachedBooks.length === 0 || forceRefresh) {
    console.log(`[Cache] 🔄 Fetching from Google Sheets...`);
    cachedBooks = await getAllBooks(SHEET_ID);
    console.log(`[Cache] ✅ Loaded ${cachedBooks.length} books.`);
  }
  return cachedBooks;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const SUPPORTED_EXTENSIONS = [".pdf", ".epub", ".mobi", ".azw", ".azw3"];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Background worker to enrich metadata
 */
async function enrichMetadataWorker(spreadsheetId, scanId) {
  // If this specific scan session is already being enriched, don't start it again
  if (enrichingScanId === scanId) return;
  
  enrichingScanId = scanId;
  isEnriching = true;
  
  try {
    console.log(`\n🧵 [Enricher #${scanId}] Starting enrichment phase...`);
    // Ensure we use the latest books from cache
    const books = await getBooksCached();
    
    const needsEnrichment = (b) =>
      b.goodreadsCheck?.toLowerCase() === "no" ||
      (b.goodreadsId && b.source === "Filename Parser");

    while (scanId === currentScanId) {
      const pending = books.filter(needsEnrichment);
      enrichResults.total = pending.length;
      
      if (pending.length === 0) {
        if (!isScanning) break;
        await delay(3000);
        continue;
      }
      
      const book = pending[0];
      enrichResults.current++;
      enrichResults.currentTitle = book.title;
      console.log(`[Enricher #${scanId}] Processing: ${book.title}`);

      try {
        await delay(5000);
        if (scanId !== currentScanId) break;

        const absolutePath = await getValidatedPath(book.location);
        if (!absolutePath) {
           console.warn(`[Enricher #${scanId}] File missing, skipping: ${book.location}`);
           book.goodreadsCheck = "Error";
           continue;
        }

        const metadata = await getBookMetadata(
          path.basename(book.location),
          book.location,
          book.goodreadsId,
          book,
        );
        metadata.status = book.status;
        metadata.rowIndex = book.rowIndex;
        
        if (!metadata.size || metadata.size === "0.00" || metadata.size === "N/A") {
          metadata.size = book.size;
        }

        if (scanId !== currentScanId) break;
        await addOrUpdateBook(spreadsheetId, metadata, books);
        
        const idx = books.findIndex((b) => b.location === metadata.location);
        if (idx !== -1) {
          books[idx] = { ...books[idx], ...metadata };
          cachedBooks = books;
        }
      } catch (err) {
        console.error(`[Enricher Error #${scanId}] ${book.title}:`, err.message);
        const idx = books.findIndex((b) => b.location === book.location);
        if (idx !== -1) books[idx].goodreadsCheck = "Error";
      }
    }
  } catch (err) {
    console.error(`[Enricher Fatal Error #${scanId}]`, err.message);
  } finally {
    if (scanId === currentScanId) {
      console.log(`\n✅ [Enricher #${scanId}] Finished.`);
      isEnriching = false;
      enrichingScanId = -1;
      enrichResults.currentTitle = "";
    } else {
      console.log(`\n🛑 [Enricher #${scanId}] Aborted and cleaning up.`);
    }
  }
}

/**
 * PHASE 1: Quick Scan
 */
async function startQuickScan(
  dir,
  existingBooksMap,
  allBooksArray,
  foundPathsSet,
  scanId
) {
  console.log(`\n*****************************************`);
  console.log(`🔍 [SCANNER #${scanId}] STARTING AT: ${dir}`);
  console.log(`*****************************************\n`);

  const filenameMap = new Map();
  for (const book of allBooksArray) {
    const loc = (book.location || "").toString().trim().normalize("NFC");
    const fname = path.basename(loc);
    if (fname) {
      if (!filenameMap.has(fname)) filenameMap.set(fname, []);
      filenameMap.get(fname).push(book);
    }
  }

  let filesFoundCount = 0;
  let foldersScannedCount = 0;

  async function scanRecursive(currentDir) {
    if (scanId !== currentScanId) return;
    foldersScannedCount++;
    try {
      let entries = [];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch (e) {
        const normalizedDir = currentDir.normalize("NFC");
        if (normalizedDir !== currentDir) {
          entries = await fs.readdir(normalizedDir, { withFileTypes: true });
        } else {
          throw e;
        }
      }

      for (const entry of entries) {
        if (scanId !== currentScanId) return;
        const res = path.resolve(currentDir, entry.name);
        if (entry.isDirectory()) {
          await scanRecursive(res);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.includes(ext)) {
            filesFoundCount++;
            const fileName = entry.name;
            const relativePath = path.relative(BOOKS_PATH, res);
            const normalizedPath = relativePath.normalize("NFC");

            let bookToUpdate = existingBooksMap.get(normalizedPath);

            if (!bookToUpdate) {
              const fileNameNFC = fileName.normalize("NFC");
              const candidates = filenameMap.get(fileNameNFC) || [];
              const movedBook = candidates.find((b) => {
                const loc = (b.location || "")
                  .toString()
                  .trim()
                  .normalize("NFC");
                return !foundPathsSet.has(loc);
              });

              if (movedBook) {
                console.log(`[Scanner] ✨ MOVED: ${fileName}`);
                const oldLocationNFC = (movedBook.location || "")
                  .toString()
                  .trim()
                  .normalize("NFC");
                movedBook.location = normalizedPath;
                existingBooksMap.delete(oldLocationNFC);
                existingBooksMap.set(normalizedPath, movedBook);
                await addOrUpdateBook(SHEET_ID, movedBook, allBooksArray);
                bookToUpdate = movedBook;
              }
            }

            if (bookToUpdate) {
              foundPathsSet.add(normalizedPath);
              scanResults.skipped++;
            } else {
              console.log(`[Scanner] 🆕 NEW: ${fileName}`);
              const basicInfo = getBasicInfo(fileName, normalizedPath, res);
              await addOrUpdateBook(SHEET_ID, basicInfo, allBooksArray);
              const newBook = {
                ...basicInfo,
                rowIndex: allBooksArray.length + 2,
              };
              allBooksArray.push(newBook);
              existingBooksMap.set(normalizedPath, newBook);
              foundPathsSet.add(normalizedPath);
              scanResults.added++;
            }
            scanResults.processed++;
            cachedBooks = allBooksArray;
          }
        }
      }
    } catch (err) {
      console.error(`[Scanner] ❌ ERROR reading ${currentDir}: ${err.message}`);
      const relativeDir = path
        .relative(BOOKS_PATH, currentDir)
        .normalize("NFC");
      for (const normalizedPath of existingBooksMap.keys()) {
        if (normalizedPath.startsWith(relativeDir)) {
          foundPathsSet.add(normalizedPath);
        }
      }
    }
  }

  await scanRecursive(dir);
  if (scanId === currentScanId) {
    console.log(`\n*****************************************`);
    console.log(`✅ [SCANNER #${scanId}] FINISHED`);
    console.log(`📂 Folders scanned: ${foldersScannedCount}`);
    console.log(`📚 Files found: ${filesFoundCount}`);
    console.log(`*****************************************\n`);
  } else {
    console.log(`🛑 [SCANNER #${scanId}] ABORTED`);
  }
}

app.get("/api/scan", async (req, res) => {
  const force = req.query.force === "true";
  
  // If force is requested, we allow it even if isScanning is true by incrementing ID
  if (isScanning && !force)
    return res.json({
      message: "Scan already in progress",
      results: scanResults,
    });
  
  currentScanId++;
  const thisScanId = currentScanId;
  
  isScanning = true;
  scanResults = {
    total: 0,
    processed: 0,
    added: 0,
    skipped: 0,
    deleted: 0,
    errors: 0,
  };

  (async () => {
    try {
      console.log(`\n🚀 [Engine #${thisScanId}] Starting... (Force: ${force})`);
      await setupHeaders(SHEET_ID);
      
      const books = await getBooksCached(force);
      if (thisScanId !== currentScanId) return;

      const existingBooksMap = new Map(
        books.map((b) => [
          (b.location || "").toString().trim().normalize("NFC"),
          b,
        ]),
      );
      enrichMetadataWorker(SHEET_ID, thisScanId).catch((err) =>
        console.error("[Enricher Startup Error]", err.message),
      );

      const foundPathsSet = new Set();
      await startQuickScan(BOOKS_PATH, existingBooksMap, books, foundPathsSet, thisScanId);

      if (thisScanId !== currentScanId) return;

      // Phase 1.5: Deletion Sync
      console.log(`\n🗑️ [Engine #${thisScanId}] Checking for deleted books...`);

      if (foundPathsSet.size === 0 && existingBooksMap.size > 0) {
        console.error(
          `[Engine] 🛑 SAFETY TRIGGERED: No files found in BOOKS_PATH, but sheet has ${existingBooksMap.size} books. Aborting deletion to prevent data loss.`,
        );
        isScanning = false;
        return;
      }

      const rowsToDelete = [];
      for (const [normalizedPath, book] of existingBooksMap.entries()) {
        if (!foundPathsSet.has(normalizedPath)) {
          console.log(`[Engine] Marking for deletion: ${book.title}`);
          rowsToDelete.push(book.rowIndex);
        }
      }

      if (
        rowsToDelete.length > 50 &&
        rowsToDelete.length > existingBooksMap.size * 0.5
      ) {
        console.error(
          `[Engine] 🛑 SAFETY TRIGGERED: Attempting to delete ${rowsToDelete.length} books. Aborting.`,
        );
        isScanning = false;
        return;
      }

      if (rowsToDelete.length > 0 && thisScanId === currentScanId) {
        await deleteBooks(SHEET_ID, rowsToDelete);
        scanResults.deleted = rowsToDelete.length;
        console.log(
          `[Engine #${thisScanId}] Successfully deleted ${rowsToDelete.length} missing books from Sheets.`,
        );
        await getBooksCached(true);
      }
    } catch (err) {
      console.error("[Scan Error]", err.message);
    } finally {
      if (thisScanId === currentScanId) {
        isScanning = false;
      }
    }
  })();
  res.json({ message: "Scan started", results: scanResults, scanId: thisScanId });
});


app.get("/api/scan/status", (req, res) => {
  res.json({
    isScanning,
    isEnriching,
    results: scanResults,
    enrichment: enrichResults,
  });
});

app.get("/api/books", async (req, res) => {
  try {
    const books = await getBooksCached();
    res.json(books);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


/**
 * Helper to get absolute path and handle Unicode normalization mismatches
 */
async function getValidatedPath(relativeLocation) {
  const absolutePath = path.resolve(BOOKS_PATH, relativeLocation);
  try {
    await fs.access(absolutePath);
    return absolutePath;
  } catch {
    // Try NFC normalization (common fix for Mac/Linux mismatches)
    const nfcPath = path.resolve(BOOKS_PATH, relativeLocation.normalize("NFC"));
    try {
      await fs.access(nfcPath);
      return nfcPath;
    } catch {
      // Try NFD normalization
      const nfdPath = path.resolve(
        BOOKS_PATH,
        relativeLocation.normalize("NFD"),
      );
      try {
        await fs.access(nfdPath);
        return nfdPath;
      } catch {
        return null;
      }
    }
  }
}

app.get("/api/preview/:rowIndex", async (req, res) => {
  try {
    const rowIndex = parseInt(req.params.rowIndex);
    const books = await getAllBooks(SHEET_ID);
    const book = books.find((b) => b.rowIndex === rowIndex);
    if (!book) return res.status(404).json({ error: ERR_BOOK_NOT_FOUND });

    const absolutePath = await getValidatedPath(book.location);
    if (!absolutePath)
      return res
        .status(404)
        .json({ error: `File not found: ${book.location}` });

    const previewData = await getPreview(absolutePath);
    if (!previewData)
      return res.status(500).json({ error: "Could not generate preview" });
    res.json(previewData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/cover/:rowIndex", async (req, res) => {
  try {
    const rowIndex = parseInt(req.params.rowIndex);
    const books = await getAllBooks(SHEET_ID);
    const book = books.find((b) => b.rowIndex === rowIndex);
    if (!book) return res.status(404).send(ERR_BOOK_NOT_FOUND);

    const absolutePath = await getValidatedPath(book.location);
    if (!absolutePath)
      return res.status(404).send(`File not found: ${book.location}`);

    const cover = await extractEmbeddedCover(absolutePath);
    if (!cover) return res.status(404).send("No embedded cover found");
    res.set("Content-Type", cover.mimeType);
    res.send(cover.data);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get("/api/download/:rowIndex", async (req, res) => {
  try {
    const rowIndex = parseInt(req.params.rowIndex);
    const books = await getAllBooks(SHEET_ID);
    const book = books.find((b) => b.rowIndex === rowIndex);
    if (!book) return res.status(404).send(ERR_BOOK_NOT_FOUND);

    const absolutePath = await getValidatedPath(book.location);
    if (!absolutePath)
      return res.status(404).send(`File not found: ${book.location}`);

    const filename = path.basename(absolutePath);
    const contentType =
      mime.contentType(path.extname(filename)) || "application/octet-stream";
    res.setHeader(
      "Content-disposition",
      "attachment; filename=" + encodeURIComponent(filename),
    );
    res.setHeader("Content-type", contentType);
    res.sendFile(absolutePath);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📚 Scanning path: ${BOOKS_PATH}`);
  console.log(`=========================================`);
});
