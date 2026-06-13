const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const {
  cleanText,
  getBigrams,
  getStringSimilarity,
  extractTitle,
} = require("../utils/stringUtils");

const BYTES_PER_MB = 1024 * 1024;
const DUPLICATES_CACHE_PATH = path.join(
  __dirname,
  "../storage/duplicates.cache.json",
);
const UNKNOWN_AUTHOR = "Unknown";

const TITLE_SIMILARITY_THRESHOLD = 0.8;
const AUTHOR_SIMILARITY_THRESHOLD = 0.7;
const SIZE_DIFFERENCE_THRESHOLD = 0.1;

/**
 * Formats a book object for duplicate detection results.
 */
function formatFile(book) {
  const absolutePath = path.resolve(
    process.env.BOOKS_PATH || "",
    book.location,
  );
  let mtimeMs = 0;

  if (fsSync.existsSync(absolutePath)) {
    try {
      const stats = fsSync.statSync(absolutePath);
      mtimeMs = stats.mtimeMs;
    } catch {
      // If file disappeared between exists and stat, we use default mtimeMs 0
    }
  }

  return {
    path: book.location,
    size: book.size,
    ext: book.extension || book.location.split(".").pop().toLowerCase(),
    title: book.title,
    _mtimeMs: mtimeMs,
  };
}

/**
 * Recommendation Engine: Returns the index of the recommended file in the group.
 */
function recommendFile(files) {
  if (files.length <= 1) return 0;
  const FORMAT_PRIORITY = { epub: 5, azw3: 4, azw: 3, mobi: 2, pdf: 1 };

  return files.reduce((bestIdx, current, currentIdx, arr) => {
    const best = arr[bestIdx];
    const bestFmt = FORMAT_PRIORITY[best.ext] || 0;
    const currFmt = FORMAT_PRIORITY[current.ext] || 0;

    if (currFmt > bestFmt) return currentIdx;
    if (currFmt < bestFmt) return bestIdx;

    const bestSize = parseFloat(best.size) || 0;
    const currSize = parseFloat(current.size) || 0;

    if (best.ext === "pdf") {
      if (currSize > bestSize) return currentIdx;
    } else if (currSize < bestSize && currSize > 0) {
      return currentIdx;
    }

    if (current._mtimeMs > best._mtimeMs) return currentIdx;
    return bestIdx;
  }, 0);
}

/**
 * Calculates wasted bytes in a group.
 */
function calculateWastedBytes(group) {
  const recommendedIdx = group.findIndex((f) => f.recommended);
  const keepIdx = recommendedIdx !== -1 ? recommendedIdx : 0;

  const wastedMB = group.reduce((acc, f, idx) => {
    return idx !== keepIdx ? acc + (parseFloat(f.size) || 0) : acc;
  }, 0);

  return Math.round(wastedMB * BYTES_PER_MB);
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
    console.log(`[DuplicateCache] Saving to ${DUPLICATES_CACHE_PATH}...`);
    try {
      await fs.writeFile(
        DUPLICATES_CACHE_PATH,
        JSON.stringify(results),
        "utf8",
      );
      console.log(`[DuplicateCache] Successfully saved.`);
    } catch (err) {
      console.error("[DuplicateCache] Save failed:", err.message);
    }
  },
};

/**
 * Applies the recommendation engine to a group of files.
 */
function processGroup({ key, confidence, reason, files }) {
  const recommendedIdx = recommendFile(files);
  const processedFiles = files.map((f, idx) => ({
    path: f.path,
    size: f.size,
    ext: f.ext,
    recommended: idx === recommendedIdx,
  }));

  return {
    key,
    confidence,
    reason,
    recommendedFile: processedFiles[recommendedIdx].path,
    files: processedFiles,
  };
}

/**
 * Checks if two books are duplicates based on Title (>=80%) and Author (>=70% or Unknown).
 */
function isFuzzyMatch(book1, book2) {
  const titleSim = getStringSimilarity(
    book1._titleBigrams,
    book2._titleBigrams,
  );
  if (titleSim < TITLE_SIMILARITY_THRESHOLD) return false;

  if (book1.author === UNKNOWN_AUTHOR || book2.author === UNKNOWN_AUTHOR) {
    return true;
  }

  const authorSim = getStringSimilarity(
    book1._authorBigrams,
    book2._authorBigrams,
  );
  return authorSim >= AUTHOR_SIMILARITY_THRESHOLD;
}

/**
 * Level 1: SHA256 Hash -> confirmed
 */
function detectHashDuplicates(books, handledPaths) {
  const results = [];
  const hashGroups = {};

  books
    .filter((b) => b.fileHash)
    .forEach((b) => {
      if (!hashGroups[b.fileHash]) hashGroups[b.fileHash] = [];
      hashGroups[b.fileHash].push(b);
    });

  Object.entries(hashGroups).forEach(([hash, group]) => {
    if (group.length > 1) {
      const processed = processGroup({
        key: hash,
        confidence: "confirmed",
        reason: "sha256_hash",
        files: group.map(formatFile),
      });
      results.push(processed);
      group.forEach((b) => handledPaths.add(b.location));
    }
  });
  return results;
}

/**
 * Collects fuzzy matches for a single seed book from the pool.
 */
async function collectFuzzyMatches(seed, pool, handledPaths, iterationsRef) {
  const matches = [seed];
  for (let i = 0; i < pool.length; i++) {
    if (handledPaths.has(pool[i].location)) {
      pool.splice(i, 1);
      i--;
      continue;
    }
    if (isFuzzyMatch(seed, pool[i])) {
      const match = pool.splice(i, 1)[0];
      matches.push(match);
      handledPaths.add(match.location);
      i--;
    }
    if (++iterationsRef.count % 50 === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }
  return matches;
}

/**
 * Processes one prefix pool for fuzzy duplicates.
 */
async function processFuzzyPool(pool, handledPaths, iterationsRef) {
  const results = [];
  while (pool.length > 0) {
    const seed = pool.shift();
    if (handledPaths.has(seed.location)) continue;
    const matches = await collectFuzzyMatches(seed, pool, handledPaths, iterationsRef);
    if (matches.length > 1) {
      results.push(
        processGroup({
          key: `Fuzzy: ${seed.title}`,
          confidence: "probable",
          reason: "fuzzy_match",
          files: matches.map(formatFile),
        }),
      );
      handledPaths.add(seed.location);
    }
  }
  return results;
}

/**
 * Level 2: Fuzzy Title & Author Match -> probable (Optimized)
 */
async function detectFuzzyDuplicates(books, handledPaths, onProgress) {
  const available = books.filter(
    (b) => !handledPaths.has(b.location) && b._cleanTitle.length >= 3,
  );

  // Group by first 3 characters of cleaned title to reduce O(n^2) search space
  const titleGroups = {};
  available.forEach((b) => {
    const prefix = b._cleanTitle.substring(0, 3);
    if (!titleGroups[prefix]) titleGroups[prefix] = [];
    titleGroups[prefix].push(b);
  });

  const prefixes = Object.keys(titleGroups);
  const totalPrefixes = prefixes.length;
  const iterationsRef = { count: 0 };
  const results = [];

  for (let pIdx = 0; pIdx < totalPrefixes; pIdx++) {
    if (onProgress) {
      onProgress({
        total: totalPrefixes,
        current: pIdx,
        percent: Math.round((pIdx / totalPrefixes) * 100),
      });
    }
    const pool = titleGroups[prefixes[pIdx]];
    const poolResults = await processFuzzyPool(pool, handledPaths, iterationsRef);
    results.push(...poolResults);
  }
  return results;
}

/**
 * Level 3: Goodreads ID -> probable
 */
function detectIdDuplicates(books, handledPaths) {
  const results = [];
  const idGroups = {};

  books
    .filter(
      (b) =>
        b.goodreadsId &&
        b.goodreadsCheck === "Yes" &&
        !handledPaths.has(b.location),
    )
    .forEach((b) => {
      if (!idGroups[b.goodreadsId]) idGroups[b.goodreadsId] = [];
      idGroups[b.goodreadsId].push(b);
    });

  Object.entries(idGroups).forEach(([id, group]) => {
    if (group.length > 1) {
      const processed = processGroup({
        key: `Goodreads: ${id}`,
        confidence: "probable",
        reason: "goodreads_id",
        files: group.map(formatFile),
      });
      results.push(processed);
      group.forEach((b) => handledPaths.add(b.location));
    }
  });
  return results;
}

/**
 * Collects size-based matches for a single seed book from the sorted pool.
 */
async function collectSizeMatches(seed, seedSize, pool, iterationsRef) {
  const matches = [seed];
  for (let i = 0; i < pool.length; i++) {
    const compSize = parseFloat(pool[i].size) || 0;
    // OPTIMIZATION: Since pool is sorted by size, we can break early
    if (compSize > seedSize * (1 + SIZE_DIFFERENCE_THRESHOLD)) break;

    const titleSim = getStringSimilarity(seed._titleBigrams, pool[i]._titleBigrams);
    if (titleSim >= 0.5) {
      matches.push(pool.splice(i, 1)[0]);
      i--;
    }
    if (++iterationsRef.count % 100 === 0) await new Promise((r) => setImmediate(r));
  }
  return matches;
}

/**
 * Processes one extension pool for size duplicates.
 */
async function processSizePool(ext, pool) {
  const results = [];
  const iterationsRef = { count: 0 };
  while (pool.length > 0) {
    const seed = pool.shift();
    const seedSize = parseFloat(seed.size) || 0;
    if (seedSize === 0) continue;
    const matches = await collectSizeMatches(seed, seedSize, pool, iterationsRef);
    if (matches.length > 1) {
      results.push(
        processGroup({
          key: `Size: ${ext} ~${seedSize}MB`,
          confidence: "possible",
          reason: "similar_size",
          files: matches.map(formatFile),
        }),
      );
    }
  }
  return results;
}

/**
 * Level 4: Similar Size & Format -> possible (Optimized)
 */
async function detectSizeDuplicates(books, handledPaths, onProgress) {
  const available = books.filter((b) => !handledPaths.has(b.location));
  const extGroups = {};

  available.forEach((b) => {
    const ext = b.extension || b.location.split(".").pop().toLowerCase();
    if (!extGroups[ext]) extGroups[ext] = [];
    extGroups[ext].push(b);
  });

  const extensions = Object.keys(extGroups);
  const totalExts = extensions.length;
  const results = [];

  for (let eIdx = 0; eIdx < totalExts; eIdx++) {
    if (onProgress) {
      onProgress({
        total: totalExts,
        current: eIdx,
        percent: Math.round((eIdx / totalExts) * 100),
      });
    }
    const ext = extensions[eIdx];
    const pool = [...extGroups[ext]].sort(
      (a, b) => (parseFloat(a.size) || 0) - (parseFloat(b.size) || 0),
    );
    const poolResults = await processSizePool(ext, pool);
    results.push(...poolResults);
  }
  return results;
}

/**
 * Detects duplicates in the book cache.
 */
async function detectDuplicates(books, onProgress) {
  console.log("[DuplicateDetector] Starting detectDuplicates scan.");
  const handledPaths = new Set();

  // 1. Preparation (0-10%)
  if (onProgress) onProgress({ total: books.length, current: 0, percent: 5 });

  const enhancedBooks = books.map((b, idx) => {
    const _cleanTitle = cleanText(extractTitle(b.title));
    const _cleanAuthor = cleanText(b.author);
    if (idx % 500 === 0 && onProgress) {
      onProgress({ total: books.length, current: idx, percent: 5 + Math.round((idx / books.length) * 5) });
    }
    return {
      ...b,
      _cleanTitle,
      _cleanAuthor,
      _titleBigrams: getBigrams(_cleanTitle),
      _authorBigrams: getBigrams(_cleanAuthor),
    };
  });

  // 2. Hash Match (10-15%)
  const confirmed = detectHashDuplicates(enhancedBooks, handledPaths);
  if (onProgress) onProgress({ total: books.length, current: books.length, percent: 15 });

  // 3. Fuzzy Match (15-85%) - The heaviest part
  const fuzzy = await detectFuzzyDuplicates(enhancedBooks, handledPaths, (p) => {
    if (onProgress) onProgress({ ...p, percent: 15 + Math.round((p.percent || 0) * 0.7) });
  });

  // 4. ID Match (85-90%)
  const ids = detectIdDuplicates(enhancedBooks, handledPaths);
  if (onProgress) onProgress({ total: 100, current: 90, percent: 90 });

  // 5. Size Match (90-98%)
  const possible = await detectSizeDuplicates(enhancedBooks, handledPaths, (p) => {
    if (onProgress) onProgress({ ...p, percent: 90 + Math.round((p.percent || 0) * 0.08) });
  });

  const results = {
    confirmed,
    probable: [...fuzzy, ...ids],
    possible,
    stats: {
      totalGroups: 0,
      totalWastedBytes: 0,
      totalWastedFormatted: "0 MB",
    },
  };

  const allGroups = [
    ...results.confirmed,
    ...results.probable,
    ...results.possible,
  ];
  results.stats.totalGroups = allGroups.length;
  results.stats.totalWastedBytes = allGroups.reduce(
    (acc, g) => acc + calculateWastedBytes(g.files),
    0,
  );
  results.stats.totalWastedFormatted = `${(results.stats.totalWastedBytes / BYTES_PER_MB).toFixed(2)} MB`;

  if (onProgress) onProgress({ total: 100, current: 100, percent: 100 });
  console.log("[DuplicateDetector] Finished scan, saving results.");
  await duplicateCache.save(results);
  return results;
}

module.exports = {
  detectDuplicates,
  loadCachedDuplicates: duplicateCache.load,
  clearDuplicateCache: () => fs.unlink(DUPLICATES_CACHE_PATH).catch(() => { }),
  duplicateCache,
  calculateWastedBytes,
  recommendFile,
  formatFile
};