const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const writeQueue = require("./writeQueue.service");

let isHashing = false;

/**
 * Calculates the SHA256 hash of a file using a stream.
 * @param {string} absolutePath Path to the file.
 * @returns {Promise<string>} SHA256 hash.
 */
async function calculateFileHash(absolutePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

/**
 * Runs the background hash worker to calculate file hashes for books.
 * @param {Object} config Worker configuration.
 */
async function runHashWorker(config) {
  if (isHashing) return;
  isHashing = true;
  
  const { getBooks, updateCache, libraryRoot, isContextValid, scanId } = config;

  try {
    // Only hash books that don't have a hash yet
    const books = await getBooks();
    const pending = books.filter((book) => !book.fileHash);

    console.log(`[HashWorker] Found ${pending.length} books to hash.`);

    for (const book of pending) {
      if (!isContextValid(scanId)) break;
      
      const absolutePath = path.resolve(libraryRoot, book.location);
      try {
        if (!fs.existsSync(absolutePath)) continue;

        const hash = await calculateFileHash(absolutePath);
        
        const updatedBook = { ...book, fileHash: hash };
        updateCache(updatedBook);
        writeQueue.enqueue(updatedBook);
        
        // Small delay to prevent high I/O impact
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`[HashWorker] Failed to hash ${book.location}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error("[HashWorker] Fatal error:", error.message);
  } finally {
    isHashing = false;
    console.log("[HashWorker] Finished.");
  }
}

module.exports = { runHashWorker };
