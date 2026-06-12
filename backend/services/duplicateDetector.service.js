const fs = require("fs").promises;
const path = require("path");

const BYTES_PER_MB = 1024 * 1024;
const DUPLICATES_CACHE_PATH = path.join(__dirname, "../storage/duplicates.cache.json");

/**
 * Formats a book object for duplicate detection results.
 */
function formatFile(book) {
  return {
    path: book.location,
    size: book.size,
    ext: book.extension || (book.location.split(".").pop()),
    title: book.title,
  };
}

/**
 * Calculates wasted bytes in a group.
 */
function calculateWastedBytes(group) {
  if (group.length <= 1) return 0;
  const sizesMB = group.map((b) => parseFloat(b.size) || 0);
  const wastedMB = sizesMB.slice(1).reduce((sum, size) => sum + size, 0);
  return Math.round(wastedMB * BYTES_PER_MB);
}

/**
 * Normalizes a filename for comparison.
 */
function normalizeFilename(location) {
  const filename = location.split("/").pop();
  const nameWithoutExt = filename.includes(".") 
    ? filename.substring(0, filename.lastIndexOf(".")) 
    : filename;
  return nameWithoutExt.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Calculates string similarity using Dice Coefficient.
 */
function getStringSimilarity(b1, b2) {
  if (!b1 || !b2 || b1.size === 0 || b2.size === 0) return 0;
  let intersect = 0;
  for (const b of b1) {
    if (b2.has(b)) intersect++;
  }
  return (2.0 * intersect) / (b1.size + b2.size);
}

function getBigrams(str) {
  const bigrams = new Set();
  if (!str || str.length < 2) return bigrams;
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * Groups an array of objects.
 */
function groupBy(arr, keyGetter) {
  const groups = {};
  arr.forEach((item) => {
    const key = typeof keyGetter === "function" ? keyGetter(item) : item[keyGetter];
    if (!key) return;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  });
  return groups;
}

/**
 * Cache management
 */
const duplicateCache = {
  async load() {
    try {
      const data = await fs.readFile(DUPLICATES_CACHE_PATH, "utf8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  },
  async save(results) {
    try {
      await fs.writeFile(DUPLICATES_CACHE_PATH, JSON.stringify(results), "utf8");
    } catch (err) {
      console.error("[DuplicateCache] Save failed:", err.message);
    }
  },
  async clear() {
    try {
      await fs.unlink(DUPLICATES_CACHE_PATH);
    } catch {
      // Ignore if not exists
    }
  }
};

/**
 * Detects duplicates in the book cache.
 */
async function detectDuplicates(books) {
  const results = {
    confirmed: [],
    probable: [],
    possible: [],
    stats: {
      totalGroups: 0,
      totalWastedBytes: 0,
      totalWastedFormatted: "0 MB",
    },
  };

  const handledPaths = new Set();
  
  // Optimization: Pre-calculate bigrams
  const booksWithBigrams = books.map(b => ({
    ...b,
    _bigrams: getBigrams(normalizeFilename(b.location))
  }));

  // Level 1: SHA256 Hash -> confirmed
  const hashGroups = groupBy(books.filter((b) => b.fileHash), "fileHash");
  Object.entries(hashGroups).forEach(([hash, group]) => {
    if (group.length > 1) {
      results.confirmed.push({
        key: hash,
        confidence: "confirmed",
        files: group.map(formatFile),
      });
      results.stats.totalWastedBytes += calculateWastedBytes(group);
      group.forEach((b) => handledPaths.add(b.location));
    }
  });

  // Level 2: File Size + Extension + Filename Similarity (>50%) -> probable
  const sizeExtGroups = groupBy(
    booksWithBigrams.filter((b) => !handledPaths.has(b.location)),
    (b) => `${b.size}_${b.extension || b.location.split(".").pop()}`
  );

  Object.entries(sizeExtGroups).forEach(([key, group]) => {
    if (group.length <= 1) return;
    const pool = [...group];
    while (pool.length > 0) {
      const seed = pool.shift();
      const matches = [seed];
      for (let i = 0; i < pool.length; i++) {
        if (getStringSimilarity(seed._bigrams, pool[i]._bigrams) >= 0.5) {
          matches.push(pool.splice(i, 1)[0]);
          i--;
        }
      }
      if (matches.length > 1) {
        results.probable.push({
          key: `Size/Ext: ${key}`,
          confidence: "probable",
          files: matches.map(formatFile),
        });
        results.stats.totalWastedBytes += calculateWastedBytes(matches);
        matches.forEach((b) => handledPaths.add(b.location));
      }
    }
  });

  // Level 3: Goodreads ID -> probable
  const idGroups = groupBy(
    booksWithBigrams.filter((b) => b.goodreadsCheck === "Yes" && b.goodreadsId && !handledPaths.has(b.location)),
    "goodreadsId"
  );
  Object.entries(idGroups).forEach(([id, group]) => {
    if (group.length > 1) {
      results.probable.push({
        key: `Goodreads ID: ${id}`,
        confidence: "probable",
        files: group.map(formatFile),
      });
      results.stats.totalWastedBytes += calculateWastedBytes(group);
      group.forEach((b) => handledPaths.add(b.location));
    }
  });

  // Level 4: Normalized Filename -> possible
  const nameGroups = groupBy(
    booksWithBigrams.filter((b) => !handledPaths.has(b.location)),
    (b) => normalizeFilename(b.location)
  );
  Object.entries(nameGroups).forEach(([name, group]) => {
    if (group.length > 1) {
      results.possible.push({
        key: `Name: ${name}`,
        confidence: "possible",
        files: group.map(formatFile),
      });
      results.stats.totalWastedBytes += calculateWastedBytes(group);
    }
  });

  results.stats.totalGroups = results.confirmed.length + results.probable.length + results.possible.length;
  results.stats.totalWastedFormatted = `${(results.stats.totalWastedBytes / BYTES_PER_MB).toFixed(2)} MB`;

  await duplicateCache.save(results);
  return results;
}

module.exports = { 
  detectDuplicates, 
  loadCachedDuplicates: duplicateCache.load,
  clearDuplicateCache: duplicateCache.clear
};
