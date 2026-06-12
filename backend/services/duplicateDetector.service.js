const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");

const BYTES_PER_MB = 1024 * 1024;
const DUPLICATES_CACHE_PATH = path.join(__dirname, "../storage/duplicates.cache.json");

/**
 * Removes Vietnamese accents and diacritics.
 */
function removeAccents(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
    .toLowerCase();
}

/**
 * Cleans a filename for fuzzy matching (Level 2 & 4).
 * Removes extension, accents, common suffixes, and special characters.
 */
function cleanFilename(location) {
  let name = location.split("/").pop();
  
  // 1. Remove extension
  const lastDot = name.lastIndexOf(".");
  if (lastDot !== -1) name = name.substring(0, lastDot);
  
  // 2. Remove accents & lowercase
  name = removeAccents(name);
  
  // 3. Remove common suffixes
  const suffixes = ["(scan)", "(1)", "(2)", "_copy", "_v2", "-final", "_3"];
  for (const suffix of suffixes) {
    name = name.replace(suffix, "");
  }
  
  // 4. Remove special chars and trim
  name = name.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  
  return name;
}

/**
 * Formats a book object for duplicate detection results.
 */
function formatFile(book) {
  const absolutePath = path.resolve(process.env.BOOKS_PATH || "", book.location);
  let mtimeMs = 0;
  try {
    mtimeMs = fsSync.statSync(absolutePath).mtimeMs;
  } catch (error) {
    console.warn(`[DuplicateDetector] Could not stat file ${absolutePath}: ${error.message}`);
  }

  return {
    path: book.location,
    size: book.size,
    ext: book.extension || (book.location.split(".").pop().toLowerCase()),
    title: book.title,
    _cleanName: cleanFilename(book.location), // Keep for recommendation engine
    _mtimeMs: mtimeMs
  };
}

/**
 * Recommendation Engine (Task 3.5)
 * Returns the index of the recommended file in the group.
 */
function recommendFile(files) {
  if (files.length <= 1) return 0;

  const FORMAT_PRIORITY = { epub: 5, azw3: 4, azw: 3, mobi: 2, pdf: 1 };
  
  return files.reduce((bestIdx, current, currentIdx, arr) => {
    const best = arr[bestIdx];
    
    // 1. Format priority
    const bestFmt = FORMAT_PRIORITY[best.ext] || 0;
    const currFmt = FORMAT_PRIORITY[current.ext] || 0;
    if (currFmt > bestFmt) return currentIdx;
    if (currFmt < bestFmt) return bestIdx;
    
    // 2. Size logic (if formats have same priority)
    const bestSize = parseFloat(best.size) || 0;
    const currSize = parseFloat(current.size) || 0;
    
    if (best.ext === "pdf") {
      // PDF: Keep LARGEST
      if (currSize > bestSize) return currentIdx;
      if (currSize < bestSize) return bestIdx;
    } else {
      // EPUB/MOBI/AZW: Keep SMALLEST
      if (currSize < bestSize && currSize > 0) return currentIdx;
      if (currSize > bestSize && bestSize > 0) return bestIdx;
    }
    
    // 3. Filename cleanliness (shorter/cleaner is better, no "_copy" etc.)
    if (current._cleanName.length < best._cleanName.length) return currentIdx;
    if (current._cleanName.length > best._cleanName.length) return bestIdx;
    
    // 4. Modified Date (Newer is better)
    if (current._mtimeMs > best._mtimeMs) return currentIdx;
    
    return bestIdx;
  }, 0);
}

/**
 * Calculates wasted bytes in a group.
 * Assumes the recommended file is kept.
 */
function calculateWastedBytes(group) {
  if (group.length <= 1) return 0;
  const recommendedIdx = group.findIndex(f => f.recommended);
  const keepIdx = recommendedIdx !== -1 ? recommendedIdx : 0;
  
  let wastedMB = 0;
  group.forEach((f, idx) => {
    if (idx !== keepIdx) {
      wastedMB += parseFloat(f.size) || 0;
    }
  });
  
  return Math.round(wastedMB * BYTES_PER_MB);
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
 * Applies the recommendation engine to a group of files.
 */
function processGroup(groupInfo) {
  const { key, confidence, reason, files } = groupInfo;
  
  const recommendedIdx = recommendFile(files);
  const processedFiles = files.map((f, idx) => ({
    path: f.path,
    size: f.size,
    ext: f.ext,
    recommended: idx === recommendedIdx
  }));

  return {
    key, // Keep key for UI compatibility
    confidence,
    reason,
    recommendedFile: processedFiles[recommendedIdx].path,
    files: processedFiles
  };
}

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
  
  // Optimization: Pre-calculate bigrams for clean filenames
  const booksWithBigrams = books.map(b => {
    const cleanName = cleanFilename(b.location);
    return {
      ...b,
      _cleanName: cleanName,
      _bigrams: getBigrams(cleanName)
    };
  });

  // Level 1: SHA256 Hash -> confirmed
  const hashGroups = groupBy(booksWithBigrams.filter((b) => b.fileHash), "fileHash");
  Object.entries(hashGroups).forEach(([hash, group]) => {
    if (group.length > 1) {
      const formattedFiles = group.map(formatFile);
      const processedGroup = processGroup({
        key: hash,
        confidence: "confirmed",
        reason: "sha256_hash",
        files: formattedFiles
      });
      
      results.confirmed.push(processedGroup);
      results.stats.totalWastedBytes += calculateWastedBytes(processedGroup.files);
      group.forEach((b) => handledPaths.add(b.location));
    }
  });

  // Level 2: Fuzzy Title Match (>= 70%) -> probable
  const availableForL2 = booksWithBigrams.filter((b) => !handledPaths.has(b.location));
  const l2Pool = [...availableForL2];
  
  let l2Iterations = 0;
  while (l2Pool.length > 0) {
    const seed = l2Pool.shift();
    const matches = [seed];
    
    // Only apply fuzzy matching if the clean name is substantial enough
    if (seed._cleanName.length > 3) {
      for (let i = 0; i < l2Pool.length; i++) {
        if (getStringSimilarity(seed._bigrams, l2Pool[i]._bigrams) >= 0.70) {
          matches.push(l2Pool.splice(i, 1)[0]);
          i--;
        }
        
        // Yield to event loop periodically to prevent server freeze
        l2Iterations++;
        if (l2Iterations % 100 === 0) await new Promise(r => setImmediate(r));
      }
    }

    if (matches.length > 1) {
      const formattedFiles = matches.map(formatFile);
      const processedGroup = processGroup({
        key: `Title: ${seed._cleanName}`,
        confidence: "probable",
        reason: "fuzzy_title_match",
        files: formattedFiles
      });
      
      results.probable.push(processedGroup);
      results.stats.totalWastedBytes += calculateWastedBytes(processedGroup.files);
      matches.forEach((b) => handledPaths.add(b.location));
    }
  }

  // Yield before Level 3
  await new Promise(r => setImmediate(r));

  // Level 3: Goodreads ID -> probable
  const idGroups = groupBy(
    booksWithBigrams.filter((b) => b.goodreadsCheck === "Yes" && b.goodreadsId && !handledPaths.has(b.location)),
    "goodreadsId"
  );
  Object.entries(idGroups).forEach(([id, group]) => {
    if (group.length > 1) {
      const formattedFiles = group.map(formatFile);
      const processedGroup = processGroup({
        key: `Goodreads ID: ${id}`,
        confidence: "probable",
        reason: "goodreads_id",
        files: formattedFiles
      });
      
      results.probable.push(processedGroup);
      results.stats.totalWastedBytes += calculateWastedBytes(processedGroup.files);
      group.forEach((b) => handledPaths.add(b.location));
    }
  });

  // Yield before Level 4
  await new Promise(r => setImmediate(r));

  // Level 4: Same Format + Size Range ±10% -> possible
  const extGroups = groupBy(
    booksWithBigrams.filter((b) => !handledPaths.has(b.location)),
    (b) => b.extension || b.location.split(".").pop().toLowerCase()
  );

  for (const [ext, group] of Object.entries(extGroups)) {
    if (group.length <= 1) continue;
    
    const pool = [...group].sort((a, b) => (parseFloat(a.size) || 0) - (parseFloat(b.size) || 0));
    
    let l4Iterations = 0;
    while (pool.length > 0) {
      const seed = pool.shift();
      const seedSize = parseFloat(seed.size) || 0;
      if (seedSize === 0) continue; 
      
      const matches = [seed];
      
      for (let i = 0; i < pool.length; i++) {
        const compSize = parseFloat(pool[i].size) || 0;
        const diffPercent = Math.abs(compSize - seedSize) / seedSize;
        
        if (diffPercent <= 0.10) {
           matches.push(pool.splice(i, 1)[0]);
           i--;
        }
        
        // Yield to event loop periodically
        l4Iterations++;
        if (l4Iterations % 100 === 0) await new Promise(r => setImmediate(r));
      }
      
      if (matches.length > 1) {
        const formattedFiles = matches.map(formatFile);
        const processedGroup = processGroup({
          key: `Format: ${ext} | Size: ~${seedSize}MB`,
          confidence: "possible",
          reason: "similar_size_and_format",
          files: formattedFiles
        });
        
        results.possible.push(processedGroup);
        results.stats.totalWastedBytes += calculateWastedBytes(processedGroup.files);
      }
    }
  }

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
