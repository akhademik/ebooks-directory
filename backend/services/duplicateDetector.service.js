const BYTES_PER_MB = 1024 * 1024;

/**
 * Formats a book object for duplicate detection results.
 * @param {Object} book Book object from cache.
 * @returns {Object} Formatted file info.
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
 * Calculates wasted bytes in a group of duplicates.
 * Assumes the first file is the one kept.
 * @param {Array<Object>} group Group of duplicate book objects.
 * @returns {number} Wasted bytes.
 */
function calculateWastedBytes(group) {
  if (group.length <= 1) return 0;
  
  const sizesMB = group.map((b) => parseFloat(b.size) || 0);
  // Sum of all sizes except the first one
  const wastedMB = sizesMB.slice(1).reduce((sum, size) => sum + size, 0);
  return Math.round(wastedMB * BYTES_PER_MB);
}

/**
 * Normalizes a filename for comparison.
 * @param {string} location File location/path.
 * @returns {string} Normalized filename.
 */
function normalizeFilename(location) {
  const filename = location.split("/").pop();
  const nameWithoutExt = filename.includes(".") 
    ? filename.substring(0, filename.lastIndexOf(".")) 
    : filename;
  return nameWithoutExt.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Calculates string similarity using Dice Coefficient (bigram based).
 * Returns a value between 0 and 1.
 */
function getStringSimilarity(s1, s2) {
  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;

  const getBigrams = (str) => {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.substring(i, i + 2));
    }
    return bigrams;
  };

  const b1 = getBigrams(s1);
  const b2 = getBigrams(s2);
  let intersect = 0;
  for (const b of b1) {
    if (b2.has(b)) intersect++;
  }

  return (2.0 * intersect) / (b1.size + b2.size);
}

/**
 * Groups an array of objects by a key or a getter function.
 * @param {Array} arr Array to group.
 * @param {string|Function} keyGetter Key name or function to get the key.
 * @returns {Object} Grouped object.
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
 * Detects duplicates in the book cache.
 * @param {Array<Object>} books Array of book objects.
 * @returns {Object} Duplicate detection results.
 */
function detectDuplicates(books) {
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
    books.filter((b) => !handledPaths.has(b.location)),
    (b) => `${b.size}_${b.extension || b.location.split(".").pop()}`
  );

  Object.entries(sizeExtGroups).forEach(([key, group]) => {
    if (group.length <= 1) return;

    // Sub-group by filename similarity
    const pool = [...group];

    while (pool.length > 0) {
      const seed = pool.shift();
      const seedName = normalizeFilename(seed.location);
      const matches = [seed];

      for (let i = 0; i < pool.length; i++) {
        const compareName = normalizeFilename(pool[i].location);
        if (getStringSimilarity(seedName, compareName) >= 0.5) {
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
    books.filter((b) => b.goodreadsCheck === "Yes" && b.goodreadsId && !handledPaths.has(b.location)),
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
    books.filter((b) => !handledPaths.has(b.location)),
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

  return results;
}

module.exports = { detectDuplicates };
