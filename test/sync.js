const fs = require("fs").promises;
const path = require("path");
// Load .env from the root or backend directory if needed
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
require("dotenv").config({ path: path.resolve(__dirname, "../backend/.env") });

const { getBasicInfo } = require("../backend/scanner");
const {
  getAllBooks,
  addOrUpdateBook,
  deleteBooks,
  setupHeaders,
} = require("../backend/sheets");

// The Library Root is the base directory for all relative paths in the Google Sheet.
// By default, it's the BOOKS_PATH from your .env file.
// Normalize paths to use forward slashes, remove trailing slashes,
// apply NFC Unicode normalization, and lowercase for consistent comparison.
function normalizePath(p) {
  if (!p) return "";
  return p
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .normalize("NFC")
    .toLowerCase();
}

const LIBRARY_ROOT = normalizePath(process.env.BOOKS_PATH);
const SCAN_PATH = normalizePath(process.env.SCAN_PATH || LIBRARY_ROOT);

// Calculate the relative path of the scan scope from the library root
// Example: Root = /Ebooks, Scan = /Ebooks/FolderA => REL_SCAN_SCOPE = FolderA
const REL_SCAN_SCOPE = normalizePath(path.relative(LIBRARY_ROOT, SCAN_PATH));

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SUPPORTED_EXTENSIONS = [".pdf", ".epub", ".mobi", ".azw", ".azw3"];

/**
 * Checks if a book's location is within our current scan scope.
 */
function isLocationInScope(bookLocation) {
  const normalizedLoc = normalizePath(bookLocation);
  const normalizedScope = normalizePath(REL_SCAN_SCOPE);

  // If scope is empty or '.', we are scanning the entire library root
  if (!normalizedScope || normalizedScope === ".") {
    return true;
  }

  // A location is in scope ONLY if it starts with the scope folder.
  // We add a trailing slash to the scope to ensure we match 'FolderA/file' but not 'FolderA_Special/file'
  const scopeWithSlash = normalizedScope.endsWith("/")
    ? normalizedScope
    : normalizedScope + "/";

  const inScope =
    normalizedLoc.startsWith(scopeWithSlash) ||
    normalizedLoc === normalizedScope;

  return inScope;
}

/**
 * Recursively scans a directory for ebook files.
 */
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
          // ALWAYS calculate relative path from LIBRARY_ROOT to match the sheet
          const relativePathFromRoot = path.relative(LIBRARY_ROOT, res);
          foundPaths.add(normalizePath(relativePathFromRoot));
        }
      }
    }
  } catch (err) {
    console.error(`[Scan Error] Error reading directory ${dir}:`, err.message);
  }
  return foundPaths;
}

/**
 * Synchronizes the Google Sheet with the files on the NAS.
 */
async function syncNasWithSheet() {
  console.log(`\n🔄 [Sync] Starting synchronization...`);

  if (!LIBRARY_ROOT || !SHEET_ID) {
    console.error(
      "❌ Error: BOOKS_PATH or GOOGLE_SHEET_ID not found in environment variables.",
    );
    return;
  }

  console.log(`🏠 Library Root:  ${LIBRARY_ROOT}`);
  console.log(`🔍 Scan Path:     ${SCAN_PATH}`);
  console.log(`📊 Sheet ID:      ${SHEET_ID}`);

  try {
    await setupHeaders(SHEET_ID);

    // 1. Get immediate children of SCAN_PATH to define the "Smart Scope"
    console.log(
      `🔎 [Sync] Identifying smart scope from children of: ${SCAN_PATH}`,
    );
    const scanChildren = await fs.readdir(SCAN_PATH);
    const smartScopeSet = new Set(
      scanChildren.map((name) => normalizePath(name)),
    );
    console.log(
      `✅ [Sync] Smart scope identified with ${smartScopeSet.size} top-level items.`,
    );

    // 2. Get current files on NAS (recursive)
    console.log(`🔍 [Sync] Scanning NAS for all files in scope...`);
    const nasFilesSet = await scanDirectory(SCAN_PATH);
    console.log(`✅ [Sync] Found ${nasFilesSet.size} total files on NAS.`);

    // 3. Get current entries in Sheet
    console.log(`🔍 [Sync] Reading Google Sheet...`);
    const sheetBooks = await getAllBooks(SHEET_ID);
    console.log(`✅ [Sync] Found ${sheetBooks.length} total entries in Sheet.`);

    // 4. Build the sheet map — detect and collect duplicate rows along the way
    const sheetBooksMap = new Map();
    const duplicateRows = [];

    sheetBooks.forEach((b) => {
      const normLoc = normalizePath(b.location);
      if (sheetBooksMap.has(normLoc)) {
        // Already seen this path — mark the later row as a duplicate
        console.log(
          `🔁 [Sync] DUPLICATE found: "${b.title}" at row ${b.rowIndex} (path: ${normLoc})`,
        );
        duplicateRows.push(b.rowIndex);
      } else {
        sheetBooksMap.set(normLoc, b);
      }
    });

    // 5. Purge existing duplicates first, before any other changes
    if (duplicateRows.length > 0) {
      console.log(
        `\n🧹 [Sync] Found ${duplicateRows.length} duplicate row(s) — removing them first...`,
      );
      await deleteBooks(SHEET_ID, duplicateRows);
      console.log(`✅ [Sync] Duplicates removed.`);
    } else {
      console.log(`✅ [Sync] No duplicates found in Sheet.`);
    }

    // 6. Identify books to delete (in scope but missing from NAS)
    const rowsToDelete = [];

    console.log(`\n🕵️ [Sync] Checking for deletions...`);
    let outOfScopeCount = 0;
    for (const [location, book] of sheetBooksMap.entries()) {
      // SMART SCOPE CHECK:
      // A book is in scope ONLY if its first path component is in our smartScopeSet.
      const firstComponent = normalizePath(location.split("/")[0]);

      if (smartScopeSet.has(firstComponent)) {
        // If it's in our scan scope but NOT on the disk anymore, delete it.
        if (!nasFilesSet.has(location)) {
          console.log(`🗑️ [Sync] DELETE: ${book.title}`);
          console.log(`   - Path: ${location}`);
          rowsToDelete.push(book.rowIndex);
        }
      } else {
        // This book belongs to a folder we ARE NOT scanning right now
        outOfScopeCount++;
      }
    }

    console.log(
      `ℹ️ [Sync] Total in Sheet (after dedup): ${sheetBooksMap.size}`,
    );
    console.log(`ℹ️ [Sync] Out of Scope (Safe): ${outOfScopeCount}`);
    console.log(`ℹ️ [Sync] Marked for Deletion: ${rowsToDelete.length}`);

    if (rowsToDelete.length > 0) {
      // Safety confirmation for large deletions
      if (rowsToDelete.length > 100) {
        console.log(
          `\n⚠️  WARNING: You are about to delete ${rowsToDelete.length} books.`,
        );
        console.log(
          `   This is a large number. Please double check the "Path" examples above.`,
        );
        console.log(`   If this looks wrong, stop the script NOW (Ctrl+C).`);
        console.log(`   Waiting 10 seconds before proceeding...`);
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      console.log(`📤 [Sync] Deleting missing entries from Sheet...`);
      await deleteBooks(SHEET_ID, rowsToDelete);
      console.log(
        `✅ [Sync] Successfully deleted ${rowsToDelete.length} books.`,
      );
    } else {
      console.log(`✅ [Sync] No books to delete in this scope.`);
    }

    // 7. Identify books to add (on NAS but not in Sheet)
    console.log(`\n🕵️ [Sync] Checking for new books to add...`);
    let addedCount = 0;
    for (const normalizedPathFromRoot of nasFilesSet) {
      if (!sheetBooksMap.has(normalizedPathFromRoot)) {
        const fileName = path.basename(normalizedPathFromRoot);
        // Resolve absolute path using original-case LIBRARY_ROOT
        const absolutePath = path.resolve(
          process.env.BOOKS_PATH,
          normalizedPathFromRoot,
        );

        console.log(`➕ [Sync] ADD: ${fileName}`);
        console.log(`   - Path: ${normalizedPathFromRoot}`);
        const basicInfo = getBasicInfo(
          fileName,
          normalizedPathFromRoot,
          absolutePath,
        );

        await addOrUpdateBook(SHEET_ID, basicInfo);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      console.log(`✅ [Sync] Added ${addedCount} new books.`);
    } else {
      console.log(`✅ [Sync] No new books to add.`);
    }

    console.log(`\n✨ [Sync] Synchronization complete!`);
    console.log(`📋 [Sync] Summary:`);
    console.log(`   - Duplicates removed : ${duplicateRows.length}`);
    console.log(`   - Stale entries deleted: ${rowsToDelete.length}`);
    console.log(`   - New books added    : ${addedCount}`);
  } catch (error) {
    console.error(`❌ [Sync] Fatal Error:`, error.message);
    console.error(error.stack);
  }
}

// Run the sync
syncNasWithSheet();
