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
 *
 * Chỉ 1 instance chạy tại một thời điểm (isHashing guard).
 * Kiểm tra isContextValid() mỗi file để dừng ngay khi scan bị cancel.
 *
 * @param {Object} config Worker configuration.
 */
async function runHashWorker(config) {
  // Guard: nếu đã có instance đang chạy thì worker này return ngay,
  // không block — để Promise.all() trong enrichmentLoop có thể resolve
  if (isHashing) {
    console.log("[HashWorker] Already running, skipping duplicate instance.");
    return;
  }

  isHashing = true;
  const { getBooks, updateCache, libraryRoot, isContextValid, scanId } = config;

  try {
    const books = await getBooks();
    const pending = books.filter((book) => !book.fileHash);
    console.log(`[HashWorker] Found ${pending.length} books to hash.`);

    for (const book of pending) {
      // Kiểm tra context TRƯỚC mỗi file — dừng ngay nếu scan bị cancel/replace
      if (!isContextValid(scanId)) {
        console.log("[HashWorker] Context invalidated, stopping early.");
        break;
      }

      const absolutePath = path.resolve(libraryRoot, book.location);
      try {
        if (!fs.existsSync(absolutePath)) continue;

        const hash = await calculateFileHash(absolutePath);
        const updatedBook = { ...book, fileHash: hash };
        updateCache(updatedBook);
        writeQueue.enqueue(updatedBook);

        // Delay nhỏ để tránh I/O spike, nhưng vẫn check context
        await new Promise((resolve) => setTimeout(resolve, 200));
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

/**
 * Resets the isHashing flag — gọi khi server cần force-reset state
 * (ví dụ: sau khi stopProcesses() được gọi).
 */
function resetHashWorker() {
  isHashing = false;
}

module.exports = { runHashWorker, resetHashWorker };