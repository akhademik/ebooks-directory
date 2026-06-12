const fs = require("fs").promises;
const path = require("path");
const { getBasicBookInfo } = require("./scannerService");
const {
  fetchAllBooks,
  batchAddBooks,
  batchDeleteBooks,
  setupSpreadsheetHeaders,
} = require("../clients/googleSheetsClient");

/**
 * Normalizes a file path.
 */
function normalizePath(filePath) {
  if (!filePath) return "";
  return filePath.replace(/\\/g, "/").replace(/\/$/, "").normalize("NFC");
}

/**
 * Checks if a book's location is within the scan scope.
 */
function isPathInScope(bookLocation, scanScope) {
  const normalizedLoc = normalizePath(bookLocation);
  const normalizedScope = normalizePath(scanScope);

  if (!normalizedScope || normalizedScope === ".") {
    return true;
  }

  const scopePrefix = normalizedScope.endsWith("/") ? normalizedScope : `${normalizedScope}/`;
  return normalizedLoc.startsWith(scopePrefix) || normalizedLoc === normalizedScope;
}

/**
 * Recursively scans a directory for ebook files.
 */
async function scanDirectoryRecursive(directory, rootPath, extensions, foundPaths = new Set()) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      
      if (entry.isDirectory()) {
        await scanDirectoryRecursive(fullPath, rootPath, extensions, foundPaths);
      } else if (entry.isSymbolicLink()) {
        await handleSymbolicLink(fullPath, rootPath, extensions, foundPaths);
      } else if (entry.isFile()) {
        handleFileEntry(entry.name, fullPath, rootPath, extensions, foundPaths);
      }
    }
  } catch (error) {
    console.error(`[SyncService] Scan error in ${directory}: ${error.message}`);
  }
  return foundPaths;
}

/**
 * Handles symbolic links during directory scanning.
 */
async function handleSymbolicLink(linkPath, rootPath, extensions, foundPaths) {
  try {
    const stats = await fs.stat(linkPath);
    if (stats.isDirectory()) {
      await scanDirectoryRecursive(linkPath, rootPath, extensions, foundPaths);
    }
  } catch (error) {
    console.warn(`[SyncService] Failed to follow symlink ${linkPath}: ${error.message}`);
  }
}

/**
 * Processes a file entry during scanning.
 */
function handleFileEntry(fileName, fullPath, rootPath, extensions, foundPaths) {
  const ext = path.extname(fileName).toLowerCase();
  if (extensions.includes(ext)) {
    const relativePath = path.relative(rootPath, fullPath);
    foundPaths.add(normalizePath(relativePath));
  }
}

/**
 * Compares disk state with spreadsheet state.
 */
async function generateSyncPreview({ libraryRoot, sheetId, extensions, scanPath }) {
  const rawLibraryRoot = libraryRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const effectiveScanPath = (scanPath || rawLibraryRoot).replace(/\\/g, "/").replace(/\/$/, "");
  
  const relScanScope = normalizePath(path.relative(rawLibraryRoot, effectiveScanPath));
  const diskFilesSet = await scanDirectoryRecursive(effectiveScanPath, rawLibraryRoot, extensions);
  const sheetBooks = await fetchAllBooks(sheetId);

  const sheetBooksMap = new Map();
  const duplicateRows = [];

  sheetBooks.forEach((book) => {
    const normLoc = normalizePath(book.location);
    if (sheetBooksMap.has(normLoc)) {
      duplicateRows.push(book.rowIndex);
    } else {
      sheetBooksMap.set(normLoc, book);
    }
  });

  const toDelete = [];
  for (const [location, book] of sheetBooksMap.entries()) {
    if (isPathInScope(location, relScanScope) && !diskFilesSet.has(location)) {
      toDelete.push({ title: book.title, rowIndex: book.rowIndex, location });
    }
  }

  const toAdd = [];
  for (const location of diskFilesSet) {
    if (!sheetBooksMap.has(location)) {
      toAdd.push({ title: path.basename(location), location });
    }
  }

  return {
    toAdd,
    toDelete,
    duplicateRows,
    totalOnDisk: diskFilesSet.size,
    totalInSheet: sheetBooks.length,
    scanScope: relScanScope || "/",
  };
}

/**
 * Applies changes to the spreadsheet based on a preview.
 */
async function performSyncAction({ libraryRoot, sheetId, previewResults }) {
  await setupSpreadsheetHeaders(sheetId);

  const deleteIndices = [
    ...previewResults.duplicateRows,
    ...previewResults.toDelete.map((book) => book.rowIndex),
  ];

  if (deleteIndices.length > 0) {
    await batchDeleteBooks(sheetId, deleteIndices);
  }

  if (previewResults.toAdd.length > 0) {
    const booksToAdd = previewResults.toAdd.map((item) => {
      const absolutePath = path.resolve(libraryRoot, item.location);
      return getBasicBookInfo(item.title, item.location, absolutePath);
    });
    await batchAddBooks(sheetId, booksToAdd);
  }

  return {
    deletedCount: deleteIndices.length,
    addedCount: previewResults.toAdd.length,
  };
}

module.exports = { generateSyncPreview, performSyncAction, normalizePath };
