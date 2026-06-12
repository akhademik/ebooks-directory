const fs = require("fs").promises;
const path = require("path");

const CACHE_FILE_PATH = path.join(__dirname, "../storage/books.cache.json");

/**
 * Loads books from the local JSON cache file.
 * @returns {Promise<Array>} The cached books array or an empty array if not found.
 */
async function load() {
  try {
    const data = await fs.readFile(CACHE_FILE_PATH, "utf8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw new Error(`cacheManager.load failed: ${error.message}`, { cause: error });
  }
}

/**
 * Saves the entire books array to the local JSON cache file.
 * @param {Array} books The array of books to cache.
 */
async function save(books) {
  try {
    const dir = path.dirname(CACHE_FILE_PATH);
    await fs.mkdir(dir, { recursive: true });
    const data = JSON.stringify(books, null, 2);
    await fs.writeFile(CACHE_FILE_PATH, data, "utf8");
  } catch (error) {
    throw new Error(`cacheManager.save failed: ${error.message}`, { cause: error });
  }
}

/**
 * Updates a single book in the provided array and saves the cache.
 * @param {string} location Unique location of the book.
 * @param {Object} fields Fields to merge into the book record.
 * @param {Array} cachedBooks The current in-memory array of books.
 */
async function updateOne(location, fields, cachedBooks) {
  const index = cachedBooks.findIndex((book) => book.location === location);
  if (index !== -1) {
    cachedBooks[index] = { ...cachedBooks[index], ...fields };
    await save(cachedBooks);
  }
}

module.exports = {
  load,
  save,
  updateOne,
};
