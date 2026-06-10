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

app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const SUPPORTED_EXTENSIONS = [".pdf", ".epub", ".mobi", ".azw", ".azw3"];

let isScanning = false;
let isEnriching = false;
let scanResults = {
  total: 0,
  processed: 0,
  added: 0,
  skipped: 0,
  deleted: 0,
  errors: 0,
};
let enrichResults = { total: 0, current: 0, currentTitle: "" };

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Background worker to enrich metadata
 */
async function enrichMetadataWorker(spreadsheetId, sharedBooksCache = null) {
  if (isEnriching) return;
  isEnriching = true;
  try {
    console.log(`\n🧵 [Enricher] Active.`);
    const books = sharedBooksCache || (await getAllBooks(spreadsheetId));
    const needsEnrichment = (b) =>
      b.goodreadsCheck?.toLowerCase() === "no" ||
      (b.goodreadsId && b.source === "Filename Parser");

    while (isScanning || books.some(needsEnrichment)) {
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
      try {
        await delay(5000);

        // Ensure size is calculated if it was missed
        if (!book.size || book.size === "N/A" || book.size === "") {
          try {
            const absolutePath = path.resolve(BOOKS_PATH, book.location);
            const stats = await fs.stat(absolutePath);
            book.size = (stats.size / (1024 * 1024)).toFixed(2);
          } catch (err) {
            if (err.code !== "ENOENT")
              console.error(`[Enricher] Size fix error: ${err.message}`);
            book.size = "0.00";
          }
        }

        const metadata = await getBookMetadata(
          path.basename(book.location),
          book.location,
          book.goodreadsId,
          book,
        );
        metadata.status = book.status;
        metadata.rowIndex = book.rowIndex;
        // Preserve size from sheet if available, otherwise getBasicInfo inside getBookMetadata handles it
        if (
          !metadata.size ||
          metadata.size === "0.00" ||
          metadata.size === "N/A"
        ) {
          metadata.size = book.size;
        }

        await addOrUpdateBook(spreadsheetId, metadata, books);
        const idx = books.findIndex((b) => b.location === metadata.location);
        if (idx !== -1) books[idx] = { ...books[idx], ...metadata };
      } catch (err) {
        console.error(`[Enricher Error] ${book.title}:`, err.message);
        const idx = books.findIndex((b) => b.location === book.location);
        if (idx !== -1) books[idx].goodreadsCheck = "Error";
      }
    }
  } catch (err) {
    console.error(`[Enricher Fatal Error]`, err.message);
  } finally {
    console.log(`\n✅ [Enricher] Finished.`);
    isEnriching = false;
    enrichResults.currentTitle = "";
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
) {
  console.log(`\n*****************************************`);
  console.log(`🔍 [SCANNER] STARTING AT: ${dir}`);
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
    foldersScannedCount++;
    try {
      // Try reading with both original and normalized paths if needed
      let entries = [];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch (e) {
        // If failed, try normalizing to NFC (common fix for network drives on Mac)
        const normalizedDir = currentDir.normalize("NFC");
        if (normalizedDir !== currentDir) {
          entries = await fs.readdir(normalizedDir, { withFileTypes: true });
        } else {
          throw e;
        }
      }

      if (entries.length === 0) {
        // console.log(`[Scanner] ℹ️ Empty directory: ${currentDir}`);
      }

      for (const entry of entries) {
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
          }
        }
      }
    } catch (err) {
      console.error(`[Scanner] ❌ ERROR reading ${currentDir}: ${err.message}`);
      // IMPORTANT: If we can't read a directory, we MUST add all books from that directory
      // to foundPathsSet so they aren't deleted by mistake.
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
  console.log(`\n*****************************************`);
  console.log(`✅ [SCANNER] FINISHED`);
  console.log(`📂 Folders scanned: ${foldersScannedCount}`);
  console.log(`📚 Files found: ${filesFoundCount}`);
  console.log(`*****************************************\n`);
}

app.get("/api/scan", async (req, res) => {
  if (isScanning)
    return res.json({
      message: "Scan already in progress",
      results: scanResults,
    });
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
      console.log(`\n🚀 [Engine] Starting...`);
      await setupHeaders(SHEET_ID);
      const books = await getAllBooks(SHEET_ID);
      const existingBooksMap = new Map(
        books.map((b) => [
          (b.location || "").toString().trim().normalize("NFC"),
          b,
        ]),
      );
      enrichMetadataWorker(SHEET_ID, books).catch((err) =>
        console.error("[Enricher Startup Error]", err.message),
      );

      const foundPathsSet = new Set();
      await startQuickScan(BOOKS_PATH, existingBooksMap, books, foundPathsSet);

      // Phase 1.5: Deletion Sync
      console.log(`\n🗑️ [Engine] Checking for deleted books...`);

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

      // Safety check: Don't delete more than 20% of the library at once unless it's a small library
      if (
        rowsToDelete.length > 50 &&
        rowsToDelete.length > existingBooksMap.size * 0.5
      ) {
        console.error(
          `[Engine] 🛑 SAFETY TRIGGERED: Attempting to delete ${rowsToDelete.length} books (${Math.round((rowsToDelete.length / existingBooksMap.size) * 100)}% of library). This is likely a path mismatch. Aborting.`,
        );
        isScanning = false;
        return;
      }

      if (rowsToDelete.length > 0) {
        await deleteBooks(SHEET_ID, rowsToDelete);
        scanResults.deleted = rowsToDelete.length;
        console.log(
          `[Engine] Successfully deleted ${rowsToDelete.length} missing books from Sheets.`,
        );
      }
    } catch (err) {
      console.error("[Scan Error]", err.message);
    } finally {
      isScanning = false;
    }
  })();
  res.json({ message: "Scan started", results: scanResults });
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
    const books = await getAllBooks(SHEET_ID);
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
