const { batchUpdateBooks } = require("../clients/googleSheetsClient");

/** @type {Array<Object>} */
let queue = [];
/** @type {Array<number>} */
let deleteQueue = [];
let isFlushing = false;
let flushInterval = null;
const config = { sheetId: null, onFlushSuccess: null, onAfterDelete: null };

/**
 * Initializes the write queue with necessary configuration.
 * @param {Object} options Configuration options.
 */
function init({ sheetId, onFlushSuccess, onAfterDelete }) {
  config.sheetId = sheetId;
  config.onFlushSuccess = onFlushSuccess;
  config.onAfterDelete = onAfterDelete;
  
  if (!flushInterval) {
    // Flush every 10 seconds as per Task 1.1
    flushInterval = setInterval(() => {
      flush().catch(err => console.error("[WriteQueue] Interval flush error:", err.message));
    }, 10000);
  }
}

/**
 * Adds a book record to the queue for deferred writing.
 * If the book is already in the queue, merges the new data.
 * @param {Object} bookData The book data to update.
 */
function enqueue(bookData) {
  const existingIndex = queue.findIndex(item => item.location === bookData.location);
  if (existingIndex !== -1) {
    queue[existingIndex] = { ...queue[existingIndex], ...bookData };
  } else {
    queue.push(bookData);
  }
}

/**
 * Adds a row index to the queue for deferred deletion.
 * @param {number} rowIndex The row index to delete.
 */
function enqueueDelete(rowIndex) {
  if (!deleteQueue.includes(rowIndex)) {
    deleteQueue.push(rowIndex);
  }
}

/**
 * Flushes the queue by sending all pending updates to Google Sheets in a batch.
 */
async function flush() {
  if (isFlushing || (queue.length === 0 && deleteQueue.length === 0) || !config.sheetId) {
    return;
  }

  isFlushing = true;
  
  try {
    // 1. Handle updates
    if (queue.length > 0) {
      const itemsToFlush = [...queue];
      console.log(`[WriteQueue] ⏳ Flushing ${itemsToFlush.length} updates to Google Sheets...`);
      await batchUpdateBooks(config.sheetId, itemsToFlush);
      
      // Remove only items that were successfully flushed
      queue = queue.filter(item => !itemsToFlush.some(flushed => flushed.location === item.location));
      console.log(`[WriteQueue] ✅ Successfully flushed ${itemsToFlush.length} updates.`);
      
      if (config.onFlushSuccess) {
        await config.onFlushSuccess();
      }
    }

    // 2. Handle deletions
    if (deleteQueue.length > 0) {
      const { batchDeleteBooks } = require("../clients/googleSheetsClient");
      const indicesToDelete = [...deleteQueue];
      console.log(`[WriteQueue] ⏳ Deleting ${indicesToDelete.length} rows from Google Sheets...`);
      await batchDeleteBooks(config.sheetId, indicesToDelete);
      deleteQueue = [];
      console.log(`[WriteQueue] ✅ Successfully deleted ${indicesToDelete.length} rows.`);
      
      if (config.onAfterDelete) {
        await config.onAfterDelete(indicesToDelete);
      }
    }
  } catch (error) {
    console.error(`[WriteQueue] ❌ Flush failed: ${error.message}. Keeping items in queue for retry.`);
  } finally {
    isFlushing = false;
  }
}

/**
 * Stops the flush interval and performs a final flush.
 */
async function shutdown() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  await flush();
}

module.exports = {
  init,
  enqueue,
  enqueueDelete,
  flush,
  shutdown,
};
