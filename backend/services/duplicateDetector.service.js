const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const {
  cleanText,
  getBigrams,
  getStringSimilarity,
  extractTitle,
} = require("../utils/stringUtils");

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────
const BYTES_PER_MB = 1024 * 1024;
const DUPLICATES_CACHE_PATH = path.join(
  __dirname,
  "../storage/duplicates.cache.json",
);
const UNKNOWN_AUTHOR = "Unknown";
const EBOOK_EXTENSIONS = new Set([
  "epub", "pdf", "azw", "azw3", "mobi", "djvu", "fb2", "lit", "cbz", "cbr",
]);

// Detection thresholds
const TITLE_SIMILARITY_THRESHOLD = 0.8;   // fuzzy title match
const AUTHOR_SIMILARITY_THRESHOLD = 0.7;   // fuzzy author match
const FILENAME_FUZZY_THRESHOLD = 0.75;  // fuzzy filename match (tầng 4)
const SIZE_DIFFERENCE_THRESHOLD = 0.1;   // ±10% filesize window
const MIN_SIZE_MB = 0.05;  // bỏ qua file <50KB ở tầng size
const SIZE_TITLE_THRESHOLD = 0.6;   // title sim khi kết hợp với size

// Cache TTL
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24 giờ — rescan tự động sau khoảng này

// ─────────────────────────────────────────────────────────────
//  HELPERS: formatFile / recommendFile / calculateWastedBytes
// ─────────────────────────────────────────────────────────────

/**
 * Formats a book object for duplicate detection results.
 * Also reads mtime from disk for recommendation engine tie-breaking.
 */
function formatFile(book) {
  const absolutePath = path.resolve(
    process.env.BOOKS_PATH || "",
    book.location,
  );
  let mtimeMs = 0;
  if (fsSync.existsSync(absolutePath)) {
    try {
      mtimeMs = fsSync.statSync(absolutePath).mtimeMs;
    } catch {
      // file disappeared between existsSync and statSync — use default 0
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
 * Recommendation Engine: returns index of the best file to keep.
 *
 * Priority order:
 *   1. Format quality: epub > azw3 > azw > mobi > pdf > others
 *   2. For epub/azw*: smaller file (less bloat), for pdf: larger (better scan)
 *   3. Tie-break: most recently modified
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
 * Calculates wasted bytes for a group (everything except the recommended file).
 */
function calculateWastedBytes(group) {
  const keepIdx = group.findIndex((f) => f.recommended);
  const keep = keepIdx !== -1 ? keepIdx : 0;
  const wastedMB = group.reduce(
    (acc, f, idx) => (idx !== keep ? acc + (parseFloat(f.size) || 0) : acc),
    0,
  );
  return Math.round(wastedMB * BYTES_PER_MB);
}

// ─────────────────────────────────────────────────────────────
//  CACHE
//
//  3 cơ chế invalidation:
//    1. TTL (24h)   — load() trả null nếu _savedAt quá cũ
//    2. Force       — clearDuplicateCache() xóa file, dùng khi
//                     caller muốn force rescan (?refresh=true)
//    3. Auto-clear  — invalidateOnBooksChange() gọi khi book
//                     cache sync lại từ Sheets, đảm bảo duplicate
//                     list không stale khi data nguồn thay đổi
// ─────────────────────────────────────────────────────────────
const duplicateCache = {
  async load() {
    try {
      const data = await fs.readFile(DUPLICATES_CACHE_PATH, "utf8");
      const parsed = JSON.parse(data);

      // TTL check: nếu cache quá cũ thì coi như không có
      if (parsed._savedAt && Date.now() - parsed._savedAt > CACHE_TTL_MS) {
        console.log(
          `[DuplicateCache] Cache expired (age: ${Math.round((Date.now() - parsed._savedAt) / 3600000)}h), will rescan.`,
        );
        return null;
      }

      // Trả về results sạch, bỏ internal field _savedAt
      const { _savedAt, ...results } = parsed;
      return results;
    } catch {
      return null;
    }
  },
  async save(results) {
    console.log(`[DuplicateCache] Saving to ${DUPLICATES_CACHE_PATH}...`);
    try {
      // Ghi kèm timestamp để TTL check ở load()
      await fs.writeFile(
        DUPLICATES_CACHE_PATH,
        JSON.stringify({ ...results, _savedAt: Date.now() }),
        "utf8",
      );
      console.log("[DuplicateCache] Successfully saved.");
    } catch (err) {
      console.error("[DuplicateCache] Save failed:", err.message);
    }
  },
  async clear() {
    try {
      await fs.unlink(DUPLICATES_CACHE_PATH);
      console.log("[DuplicateCache] Cache cleared.");
    } catch {
      // File không tồn tại — không sao
    }
  },
};

// ─────────────────────────────────────────────────────────────
//  processGroup — applies recommendation engine to a raw group
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
//  FILENAME UTILITIES  (new — ported from AppScript v4)
// ─────────────────────────────────────────────────────────────

/**
 * Strips the extension from a filename and cleans the result.
 * "Sapiens - Yuval Noah Harari.epub" → "sapiens yuval noah harari"
 */
function cleanFilename(location) {
  const base = path.basename(location);
  const dot = base.lastIndexOf(".");
  const name = dot !== -1 ? base.substring(0, dot) : base;
  return cleanText(name);            // reuse existing cleanText from stringUtils
}

/**
 * Builds a block key from the first 2 tokens × first 2 chars each.
 * Better than a raw 3-char prefix for Vietnamese titles where many books
 * share common opening words ("bac", "con", "mot"…).
 *
 * "nguyen van a b c"  → "ng va"
 * "nguyen van d"      → "ng va"   ← same block → will be fuzzy-compared
 * "tran thi b"        → "tr th"   ← different block → never compared
 */
function filenameBlockKey(cleanName) {
  const tokens = cleanName.split(" ").filter(Boolean);
  return tokens
    .slice(0, 2)
    .map((t) => t.substring(0, 2))
    .join(" ");
}

// ─────────────────────────────────────────────────────────────
//  LEVEL 1 — SHA-256 Hash  →  confidence: "confirmed"
//
//  Bit-for-bit identical files. No false positives possible.
//  Run first so these paths are excluded from every later level.
// ─────────────────────────────────────────────────────────────
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
    if (group.length < 2) return;
    results.push(
      processGroup({
        key: hash,
        confidence: "confirmed",
        reason: "sha256_hash",
        files: group.map(formatFile),
      }),
    );
    group.forEach((b) => handledPaths.add(b.location));
  });

  return results;
}

// ─────────────────────────────────────────────────────────────
//  LEVEL 2 — Goodreads ID  →  confidence: "confirmed"
//
//  Moved BEFORE fuzzy: same Goodreads ID = same work with certainty.
//  Removing these from the pool first prevents them from polluting
//  the fuzzy results with lower-confidence duplicates.
//
//  Original code had this after fuzzy (levels 3→4), which meant
//  many confirmed duplicates were also emitted as "probable" by
//  the fuzzy pass. The new order eliminates that redundancy.
// ─────────────────────────────────────────────────────────────
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
    if (group.length < 2) return;
    results.push(
      processGroup({
        key: `Goodreads: ${id}`,
        confidence: "confirmed",   // upgraded from "probable" — ID match is definitive
        reason: "goodreads_id",
        files: group.map(formatFile),
      }),
    );
    group.forEach((b) => handledPaths.add(b.location));
  });

  return results;
}

// ─────────────────────────────────────────────────────────────
//  LEVEL 3 — Fuzzy Title + Author  →  confidence: "probable"
//
//  Blocking strategy: group by first 2 tokens × 2 chars each
//  instead of raw 3-char prefix. For Vietnamese collections
//  where many titles share common openers ("bac", "con", "mot"),
//  the 3-char prefix creates oversized blocks that are slow.
//  The 2-token block key produces more balanced, smaller groups.
//
//  Within each block: seed-pool O(k²) with early setImmediate
//  yield every 50 iterations to keep the event loop responsive.
// ─────────────────────────────────────────────────────────────

/** Returns true if book1 and book2 are a fuzzy title+author match. */
function isFuzzyMatch(book1, book2) {
  const titleSim = getStringSimilarity(book1._titleBigrams, book2._titleBigrams);
  if (titleSim < TITLE_SIMILARITY_THRESHOLD) return false;

  // If either author is unknown, title similarity alone is sufficient
  if (book1.author === UNKNOWN_AUTHOR || book2.author === UNKNOWN_AUTHOR) {
    return true;
  }

  const authorSim = getStringSimilarity(book1._authorBigrams, book2._authorBigrams);
  return authorSim >= AUTHOR_SIMILARITY_THRESHOLD;
}

async function collectFuzzyMatches(seed, pool, handledPaths, iterationsRef) {
  const matches = [seed];
  for (let i = 0; i < pool.length; i++) {
    if (handledPaths.has(pool[i].location)) {
      pool.splice(i--, 1);
      continue;
    }
    if (isFuzzyMatch(seed, pool[i])) {
      const match = pool.splice(i--, 1)[0];
      matches.push(match);
      handledPaths.add(match.location);
    }
    if (++iterationsRef.count % 50 === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }
  return matches;
}

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
          reason: "fuzzy_title_author",
          files: matches.map(formatFile),
        }),
      );
      handledPaths.add(seed.location);
    }
  }
  return results;
}

async function detectFuzzyDuplicates(books, handledPaths, onProgress) {
  const available = books.filter(
    (b) => !handledPaths.has(b.location) && b._cleanTitle.length >= 3,
  );

  // Build block groups using the 2-token block key
  const titleGroups = {};
  available.forEach((b) => {
    const tokens = b._cleanTitle.split(" ").filter(Boolean);
    const blockKey = tokens
      .slice(0, 2)
      .map((t) => t.substring(0, 2))
      .join(" ");
    if (!blockKey) return;
    if (!titleGroups[blockKey]) titleGroups[blockKey] = [];
    titleGroups[blockKey].push(b);
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

// ─────────────────────────────────────────────────────────────
//  LEVEL 4 — Filename Fuzzy  →  confidence: "probable"
//
//  New level ported from AppScript v4.
//  Catches cases where metadata differs but filename is similar:
//    "nguyen van a.epub"
//    "nguyen van a b c d.pdf"
//    "nguyen_van_a.mobi"
//
//  Algorithm:
//    1. Strip extension, clean filename (reuse cleanText)
//    2. Group by 2-token block key (same as fuzzy title level)
//    3. Within each block:
//       a. Exact match (after cleaning) → reason: "filename_exact"
//       b. Dice bigram similarity ≥ FILENAME_FUZZY_THRESHOLD
//          + Union-Find to merge transitive matches into one group
//          → reason: "filename_fuzzy"
//    4. Groups with multiple distinct extensions get flagged as
//       "different_format" (same content, different container)
// ─────────────────────────────────────────────────────────────

async function detectFilenameDuplicates(books, handledPaths, onProgress) {
  const available = books.filter(
    (b) => !handledPaths.has(b.location) &&
      EBOOK_EXTENSIONS.has((b.extension || b.location.split(".").pop().toLowerCase())),
  );

  // Pre-compute cleaned filename + block key for each book
  const enhanced = available.map((b) => ({
    ...b,
    _cleanFilename: cleanFilename(b.location),
    _ext: b.extension || b.location.split(".").pop().toLowerCase(),
  }));

  // ── Pass A: exact filename match (different extensions) ──────
  const exactGroups = {};
  enhanced.forEach((b) => {
    const key = b._cleanFilename;
    if (!key) return;
    if (!exactGroups[key]) exactGroups[key] = [];
    exactGroups[key].push(b);
  });

  const exactResults = [];

  Object.entries(exactGroups).forEach(([key, group]) => {
    const unhandled = group.filter((b) => !handledPaths.has(b.location));
    if (unhandled.length < 2) return;

    const extensions = new Set(unhandled.map((b) => b._ext));
    const reason = extensions.size > 1 ? "filename_exact_diff_format" : "filename_exact_same_format";

    exactResults.push(
      processGroup({
        key: `Filename: ${key}`,
        confidence: "probable",
        reason,
        files: unhandled.map(formatFile),
      }),
    );
    unhandled.forEach((b) => {
      handledPaths.add(b.location);
    });
  });

  // ── Pass B: fuzzy filename match (Dice bigram, blocking) ─────
  const forFuzzy = enhanced.filter((b) => !handledPaths.has(b.location));

  // Group by block key
  const blockGroups = {};
  forFuzzy.forEach((b) => {
    const bk = filenameBlockKey(b._cleanFilename);
    if (!bk) return;
    if (!blockGroups[bk]) blockGroups[bk] = [];
    blockGroups[bk].push(b);
  });

  const blockKeys = Object.keys(blockGroups);
  const totalBlocks = blockKeys.length;
  const fuzzyResults = [];
  let iterCount = 0;

  for (let bIdx = 0; bIdx < totalBlocks; bIdx++) {
    if (onProgress) {
      onProgress({
        total: totalBlocks,
        current: bIdx,
        percent: Math.round((bIdx / totalBlocks) * 100),
      });
    }

    const entries = blockGroups[blockKeys[bIdx]].filter(
      (b) => !handledPaths.has(b.location),
    );
    if (entries.length < 2) continue;

    // Union-Find to group transitive matches
    const parent = entries.map((_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (a, b) => { parent[find(a)] = find(b); };

    let anyPair = false;
    for (let a = 0; a < entries.length - 1; a++) {
      for (let b = a + 1; b < entries.length; b++) {
        const sim = getStringSimilarity(
          getBigrams(entries[a]._cleanFilename),
          getBigrams(entries[b]._cleanFilename),
        );
        if (sim >= FILENAME_FUZZY_THRESHOLD) {
          union(a, b);
          anyPair = true;
        }
        if (++iterCount % 50 === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }
    }
    if (!anyPair) continue;

    // Collect groups by root
    const roots = {};
    entries.forEach((_, i) => {
      const r = find(i);
      if (!roots[r]) roots[r] = [];
      roots[r].push(i);
    });

    Object.values(roots).forEach((idxArr) => {
      if (idxArr.length < 2) return;
      const group = idxArr.map((i) => entries[i]);
      const exts = new Set(group.map((b) => b._ext));
      fuzzyResults.push(
        processGroup({
          key: `Filename fuzzy: ${group[0]._cleanFilename}`,
          confidence: "probable",
          reason: exts.size > 1 ? "filename_fuzzy_diff_format" : "filename_fuzzy_same_format",
          files: group.map(formatFile),
        }),
      );
      group.forEach((b) => handledPaths.add(b.location));
    });
  }

  return [...exactResults, ...fuzzyResults];
}

// ─────────────────────────────────────────────────────────────
//  LEVEL 5 — Similar Size + Format  →  confidence: "possible"
//
//  Kept from original but with two improvements:
//    1. Skip files < MIN_SIZE_MB (50 KB) — tiny files like short
//       essays all round to 0.01 MB and create mass false positives
//    2. Raise title similarity gate from 0.5 → SIZE_TITLE_THRESHOLD
//       (0.6) to reduce noise when combining with size signal
//
//  Still groups by extension first, sorts by size, then uses
//  early-break sliding window (O(n log n) per extension group).
// ─────────────────────────────────────────────────────────────

async function collectSizeMatches(seed, seedSize, pool, iterationsRef) {
  const matches = [seed];
  for (let i = 0; i < pool.length; i++) {
    const compSize = parseFloat(pool[i].size) || 0;
    // Early break: pool is sorted → everything beyond this is too large
    if (compSize > seedSize * (1 + SIZE_DIFFERENCE_THRESHOLD)) break;

    const titleSim = getStringSimilarity(
      seed._titleBigrams,
      pool[i]._titleBigrams,
    );
    if (titleSim >= SIZE_TITLE_THRESHOLD) {
      matches.push(pool.splice(i--, 1)[0]);
    }
    if (++iterationsRef.count % 100 === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }
  return matches;
}

async function processSizePool(ext, pool) {
  const results = [];
  const iterationsRef = { count: 0 };
  while (pool.length > 0) {
    const seed = pool.shift();
    const seedSize = parseFloat(seed.size) || 0;
    if (seedSize < MIN_SIZE_MB) continue;   // skip tiny files
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
    results.push(...(await processSizePool(ext, pool)));
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
//  MAIN ENTRY POINT
//
//  Execution order (most → least certain):
//    1. Hash          confirmed  ~100%  — bit-for-bit identical
//    2. Goodreads ID  confirmed  ~100%  — same work by DB record
//    3. Fuzzy meta    probable    ~85%  — title+author similarity
//    4. Filename      probable    ~80%  — filename similarity
//    5. Size          possible    ~60%  — size+format+title hint
//
//  Each level removes matched books from handledPaths so later
//  levels operate on a progressively smaller, cleaner pool.
//
//  Progress budget:
//    0-5%   preparation
//    5-10%  hash
//    10-15% goodreads id
//    15-75% fuzzy meta  (heaviest)
//    75-85% filename
//    85-98% size
//    98-100% finalise + save
// ─────────────────────────────────────────────────────────────
async function detectDuplicates(books, onProgress) {
  console.log("[DuplicateDetector] Starting detectDuplicates scan.");
  const handledPaths = new Set();
  const emit = (pct) => onProgress && onProgress({ total: 100, current: pct, percent: pct });

  // ── Preparation: pre-compute bigrams for all books (0→5%) ───
  emit(0);
  const enhancedBooks = books.map((b, idx) => {
    const _cleanTitle = cleanText(extractTitle(b.title));
    const _cleanAuthor = cleanText(b.author);
    if (idx % 500 === 0) emit(Math.round((idx / books.length) * 5));
    return {
      ...b,
      _cleanTitle,
      _cleanAuthor,
      _titleBigrams: getBigrams(_cleanTitle),
      _authorBigrams: getBigrams(_cleanAuthor),
    };
  });
  emit(5);

  // ── Level 1: Hash (5→10%) ────────────────────────────────────
  const confirmed = detectHashDuplicates(enhancedBooks, handledPaths);
  emit(10);

  // ── Level 2: Goodreads ID (10→15%) ──────────────────────────
  const ids = detectIdDuplicates(enhancedBooks, handledPaths);
  emit(15);

  // ── Level 3: Fuzzy title+author (15→75%) ────────────────────
  const fuzzy = await detectFuzzyDuplicates(enhancedBooks, handledPaths, (p) => {
    onProgress && onProgress({ ...p, percent: 15 + Math.round((p.percent || 0) * 0.6) });
  });

  // ── Level 4: Filename fuzzy (75→85%) ────────────────────────
  const filename = await detectFilenameDuplicates(enhancedBooks, handledPaths, (p) => {
    onProgress && onProgress({ ...p, percent: 75 + Math.round((p.percent || 0) * 0.1) });
  });
  emit(85);

  // ── Level 5: Size+format (85→98%) ───────────────────────────
  const possible = await detectSizeDuplicates(enhancedBooks, handledPaths, (p) => {
    onProgress && onProgress({ ...p, percent: 85 + Math.round((p.percent || 0) * 0.13) });
  });
  emit(98);

  // ── Compile results ──────────────────────────────────────────
  const results = {
    confirmed: [...confirmed, ...ids],          // both are 100%-certain
    probable: [...fuzzy, ...filename],         // metadata or filename evidence
    possible,                                   // weak signal, needs review
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
  results.stats.totalWastedFormatted =
    `${(results.stats.totalWastedBytes / BYTES_PER_MB).toFixed(2)} MB`;

  emit(100);
  console.log("[DuplicateDetector] Finished scan, saving results.");
  await duplicateCache.save(results);
  return results;
}

// ─────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────

/**
 * Gọi hàm này trong cache.getBooks() sau mỗi lần sync từ Sheets.
 * Đảm bảo duplicate list không stale khi data nguồn thay đổi.
 *
 * Ví dụ dùng trong bookCache.js:
 *   const { invalidateOnBooksChange } = require("./duplicateDetector.service");
 *   // sau khi sync xong:
 *   await invalidateOnBooksChange();
 */
async function invalidateOnBooksChange() {
  await duplicateCache.clear();
  console.log("[DuplicateCache] Auto-invalidated: books source changed.");
}

module.exports = {
  detectDuplicates,
  loadCachedDuplicates: duplicateCache.load.bind(duplicateCache),
  clearDuplicateCache: duplicateCache.clear.bind(duplicateCache),
  invalidateOnBooksChange,
  duplicateCache,
  calculateWastedBytes,
  recommendFile,
  formatFile,
};