const path = require("path");
const fs = require("fs").promises;
const { enrichBookMetadata } = require("./scannerService");
const writeQueue = require("./writeQueue.service");
const { runHashWorker } = require("./hashService");

const DELAY_MS = 7000;
const RETRY_DELAY_MS = 3000;

/**
 * Validates a file path and handles Unicode normalization issues.
 */
async function getValidatedAbsolutePath(libraryRoot, relativeLocation) {
  const normalizations = ["", "NFC", "NFD"];
  
  for (const norm of normalizations) {
    const loc = norm ? relativeLocation.normalize(norm) : relativeLocation;
    const absolutePath = path.resolve(libraryRoot, loc);
    try {
      await fs.access(absolutePath);
      return absolutePath;
    } catch {
      // Skip to next normalization
    }
  }
  return null;
}

/**
 * Logs the result of a metadata enrichment attempt.
 */
function logEnrichmentResult(workerId, book, metadata) {
  const { goodreadsCheck, title, author } = metadata;
  const bookIdentifier = `"${title}" - "${author}"`;

  if (goodreadsCheck === "Yes") {
    console.log(`✅ [Worker #${workerId}] SUCCESS: ${bookIdentifier}`);
  } else if (goodreadsCheck === "Not Found") {
    console.log(`🔍 [Worker #${workerId}] NOT FOUND: ${bookIdentifier}`);
  } else {
    console.log(`⚠️ [Worker #${workerId}] FAILED: ${bookIdentifier}`);
  }
}

/**
 * Processes a single book metadata enrichment.
 */
async function processBookEnrichment({ workerId, book, config }) {
  const { scanId, updateCache, libraryRoot, isContextValid } = config;
  
  try {
    // eslint-disable-next-line sonarjs/pseudo-random
    const jitter = Math.floor(Math.random() * 5000);
    await new Promise(resolve => setTimeout(resolve, DELAY_MS + jitter));
    
    if (!isContextValid(scanId)) return;

    console.log(`🧵 [Worker #${workerId}] Fetching: "${book.title}" by "${book.author}"`);

    const absolutePath = await getValidatedAbsolutePath(libraryRoot, book.location);
    if (!absolutePath) {
      console.warn(`⚠️ [Worker #${workerId}] File not found: ${book.location}`);
      book.goodreadsCheck = "Error";
      book._isProcessing = false;
      return;
    }

    const metadata = await enrichBookMetadata({
      filename: path.basename(book.location),
      location: book.location,
      goodreadsId: book.goodreadsId,
      currentMetadata: book
    });

    if (!isContextValid(scanId)) return;

    // Merge metadata back into the book object to ensure state is shared
    Object.assign(book, metadata);
    book._isProcessing = false;

    logEnrichmentResult(workerId, book, metadata);
    writeQueue.enqueue(metadata);
    updateCache(metadata);
  } catch (error) {
    console.error(`[Worker #${workerId} Error] ${book.title}:`, error.message);
    book.goodreadsCheck = "Error";
    book._isProcessing = false;
  }
}

/**
 * Runs a single enrichment worker.
 */
async function startEnrichmentWorker(config) {
  const { scanId, state, getBooks, isContextValid, workerId } = config;
  console.log(`🧵 [Worker #${workerId}] Started for Scan #${scanId}`);

  while (isContextValid(scanId)) {
    const books = await getBooks();
    const pending = books.filter(b => {
      const check = (b.goodreadsCheck || "").toLowerCase();
      return check === "no" || (b.goodreadsId && b.source === "Filename Parser");
    });

    state.enrichment.total = pending.length;

    if (pending.length === 0) {
      if (!state.isScanning) {
        // Enrichment queue is empty and scanning is done, start hash worker
        await runHashWorker(config);
        break;
      }
      await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
      continue;
    }

    const book = pending.find(b => !b._isProcessing);
    if (!book) {
      await new Promise(res => setTimeout(res, 1000));
      continue;
    }

    book._isProcessing = true;
    state.enrichment.current++;
    state.enrichment.currentTitle = book.title;

    await processBookEnrichment({ workerId, book, config });
  }

  console.log(`🏁 [Worker #${workerId}] Finished.`);
}

/**
 * Runs the enrichment process in a loop with multiple workers.
 */
async function runEnrichmentLoop(config) {
  const NUM_WORKERS = 3;
  const workers = Array.from({ length: NUM_WORKERS }, (_, i) => 
    startEnrichmentWorker({ ...config, workerId: i + 1 })
  );

  await Promise.all(workers);
  console.log(`✅ [Enricher #${config.scanId}] All workers finished.`);
}

module.exports = { runEnrichmentLoop, getValidatedAbsolutePath };
