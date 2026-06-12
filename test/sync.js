const fs = require("fs").promises;
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
require("dotenv").config({ path: path.resolve(__dirname, "../backend/.env") });

const { getBasicInfo } = require("../backend/services/scannerService");
const {
  fetchAllBooks,
  saveBook,
  batchAddBooks,
  deleteBooks,
  setupSpreadsheetHeaders,
} = require("../backend/clients/googleSheetsClient");

const DRY_RUN = process.argv.includes("--dry-run");

function normalizePath(p) {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/$/, "").normalize("NFC");
}

const LIBRARY_ROOT = normalizePath(process.env.BOOKS_PATH);
const SCAN_PATH = normalizePath(process.env.SCAN_PATH || LIBRARY_ROOT);
const REL_SCAN_SCOPE = normalizePath(path.relative(LIBRARY_ROOT, SCAN_PATH));
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SUPPORTED_EXTENSIONS = [".pdf", ".epub", ".mobi", ".azw", ".azw3"];

function isLocationInScope(bookLocation) {
  const normalizedLoc = normalizePath(bookLocation);
  const normalizedScope = normalizePath(REL_SCAN_SCOPE);
  if (!normalizedScope || normalizedScope === ".") return true;
  
  const scopeWithSlash = normalizedScope.endsWith("/") ? normalizedScope : normalizedScope + "/";
  return normalizedLoc.startsWith(scopeWithSlash) || normalizedLoc === normalizedScope;
}

async function scanDirectory(dir, foundPaths = new Set()) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDirectory(res, foundPaths);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.includes(ext)) {
          foundPaths.add(normalizePath(path.relative(LIBRARY_ROOT, res)));
        }
      }
    }
  } catch (err) {
    console.error(`[Scan Error] Error reading directory ${dir}:`, err.message);
  }
  return foundPaths;
}

async function processDuplicates(sheetBooks) {
  const sheetBooksMap = new Map();
  const duplicateRows = [];

  sheetBooks.forEach((b) => {
    const normLoc = normalizePath(b.location);
    if (sheetBooksMap.has(normLoc)) {
      console.log(`🔁 [Sync] DUPLICATE found: "${b.title}" at row ${b.rowIndex} (path: ${normLoc})`);
      duplicateRows.push(b.rowIndex);
    } else {
      sheetBooksMap.set(normLoc, b);
    }
  });

  if (duplicateRows.length > 0) {
    console.log(`\n🧹 [Sync] Found ${duplicateRows.length} duplicate row(s) — ${DRY_RUN ? "[DRY-RUN] would remove them." : "removing them first..."}`);
    if (!DRY_RUN) {
      await deleteBooks(SHEET_ID, duplicateRows);
      console.log(`✅ [Sync] Duplicates removed.`);
      console.log(`🔄 [Sync] Re-reading Sheet to get fresh row indices...`);
      const freshBooks = await fetchAllBooks(SHEET_ID);
      sheetBooksMap.clear();
      freshBooks.forEach((b) => sheetBooksMap.set(normalizePath(b.location), b));
    }
  }
  return { sheetBooksMap, duplicateRows };
}

async function processDeletions(sheetBooksMap, nasFilesSet) {
  const rowsToDelete = [];
  let outOfScopeCount = 0;

  for (const [location, book] of sheetBooksMap.entries()) {
    if (isLocationInScope(location)) {
      if (!nasFilesSet.has(location)) {
        console.log(`🗑️ [Sync] ${DRY_RUN ? "[DRY-RUN] WOULD DELETE" : "DELETE"}: "${book.title}" (Path: ${location})`);
        rowsToDelete.push(book.rowIndex);
      }
    } else {
      outOfScopeCount++;
    }
  }

  if (rowsToDelete.length > 0 && !DRY_RUN) {
    if (rowsToDelete.length > 100) {
      console.log(`\n⚠️  WARNING: You are about to delete ${rowsToDelete.length} books. Waiting 10 seconds...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    await deleteBooks(SHEET_ID, rowsToDelete);
    console.log(`✅ [Sync] Successfully deleted ${rowsToDelete.length} books.`);
  }
  return { rowsToDelete, outOfScopeCount };
}

async function processAdditions(sheetBooksMap, nasFilesSet) {
  const booksToAdd = [];
  for (const normalizedPathFromRoot of nasFilesSet) {
    if (!sheetBooksMap.has(normalizedPathFromRoot)) {
      const fileName = path.basename(normalizedPathFromRoot);
      const absolutePath = path.resolve(process.env.BOOKS_PATH, normalizedPathFromRoot);
      
      console.log(`➕ [Sync] ${DRY_RUN ? "[DRY-RUN] WOULD ADD" : "ADD"}: ${fileName} (Path: ${normalizedPathFromRoot})`);
      if (!DRY_RUN) {
        booksToAdd.push(getBasicInfo(fileName, normalizedPathFromRoot, absolutePath));
      }
    }
  }

  if (!DRY_RUN && booksToAdd.length > 0) {
    if (typeof batchAddBooks === "function") {
      await batchAddBooks(SHEET_ID, booksToAdd);
    } else {
      for (let i = 0; i < booksToAdd.length; i++) {
        await saveBook(SHEET_ID, booksToAdd[i]);
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
    }
  }
  return booksToAdd.length;
}

async function syncNasWithSheet() {
  console.log(`\n🔄 [Sync] Starting synchronization...`);
  if (!LIBRARY_ROOT || !SHEET_ID) {
    return console.error("❌ Error: BOOKS_PATH or GOOGLE_SHEET_ID not found.");
  }

  try {
    if (!DRY_RUN) await setupSpreadsheetHeaders(SHEET_ID);

    const nasFilesSet = await scanDirectory(SCAN_PATH);
    const sheetBooks = await fetchAllBooks(SHEET_ID);

    const { sheetBooksMap, duplicateRows } = await processDuplicates(sheetBooks);
    const { rowsToDelete, outOfScopeCount } = await processDeletions(sheetBooksMap, nasFilesSet);
    const addedCount = await processAdditions(sheetBooksMap, nasFilesSet);

    console.log(`\n✨ [Sync] Summary:`);
    console.log(`   - Duplicates ${DRY_RUN ? "found" : "removed"}: ${duplicateRows.length}`);
    console.log(`   - Entries ${DRY_RUN ? "that would be deleted" : "deleted"}: ${rowsToDelete.length}`);
    console.log(`   - Out of scope entries: ${outOfScopeCount}`);
    console.log(`   - Books ${DRY_RUN ? "that would be added" : "added"}: ${addedCount}`);
  } catch (error) {
    console.error(`❌ [Sync] Fatal Error:`, error.message);
  }
}

syncNasWithSheet();
