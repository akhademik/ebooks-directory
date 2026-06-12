const path = require("path");
const fs = require("fs");
const fsPromises = require("fs").promises;
const mime = require("mime-types");
const { getValidatedAbsolutePath } = require("../services/enrichmentService");
const { getPreview } = require("../utils/preview");
const { extractEmbeddedCover } = require("../utils/cover");
const { detectDuplicates, loadCachedDuplicates, clearDuplicateCache } = require("../services/duplicateDetector.service");
const writeQueue = require("../services/writeQueue.service");

const BOOKS_PATH = process.env.BOOKS_PATH;

const ERR_BOOK_NOT_FOUND = "Book not found";
const ERR_FILE_NOT_FOUND = "File not found";

/**
 * Controller for book-related operations.
 */
const bookController = {
  /**
   * Fetches all books from the cache or spreadsheet.
   */
  async getAllBooks(req, res, cache) {
    try {
      const books = await cache.getBooks();
      res.json(books);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * Generates a preview for a specific book.
   */
  async getBookPreview(req, res, cache) {
    try {
      const rowIndex = parseInt(req.params.rowIndex);
      const books = await cache.getBooks();
      const book = books.find((b) => b.rowIndex === rowIndex);
      
      if (!book) return res.status(404).json({ error: ERR_BOOK_NOT_FOUND });

      const absolutePath = await getValidatedAbsolutePath(BOOKS_PATH, book.location);
      if (!absolutePath) return res.status(404).json({ error: ERR_FILE_NOT_FOUND });

      const previewData = await getPreview(absolutePath);
      if (!previewData) return res.status(500).json({ error: "Could not generate preview" });
      
      res.json(previewData);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * Extracts and serves the cover image for a book.
   */
  async getBookCover(req, res, cache) {
    try {
      const rowIndex = parseInt(req.params.rowIndex);
      const books = await cache.getBooks();
      const book = books.find((b) => b.rowIndex === rowIndex);
      
      if (!book) return res.status(404).send(ERR_BOOK_NOT_FOUND);

      const absolutePath = await getValidatedAbsolutePath(BOOKS_PATH, book.location);
      if (!absolutePath) return res.status(404).send(ERR_FILE_NOT_FOUND);

      const cover = await extractEmbeddedCover(absolutePath);
      if (!cover) return res.status(404).send("No embedded cover found");
      
      res.set("Content-Type", cover.mimeType);
      res.send(cover.data);
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  /**
   * Handles book file download.
   */
  async downloadBook(req, res, cache) {
    try {
      const rowIndex = parseInt(req.params.rowIndex);
      const books = await cache.getBooks();
      const book = books.find((b) => b.rowIndex === rowIndex);
      
      if (!book) return res.status(404).send(ERR_BOOK_NOT_FOUND);

      const absolutePath = await getValidatedAbsolutePath(BOOKS_PATH, book.location);
      if (!absolutePath) return res.status(404).send(ERR_FILE_NOT_FOUND);

      const filename = path.basename(absolutePath);
      const contentType = mime.contentType(path.extname(filename)) || "application/octet-stream";
      
      res.setHeader("Content-disposition", `attachment; filename=${encodeURIComponent(filename)}`);
      res.setHeader("Content-type", contentType);
      res.sendFile(absolutePath);
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  /**
   * Detects duplicate books in the cache.
   */
  async getDuplicates(req, res, cache) {
    try {
      const cachedResults = await loadCachedDuplicates();
      if (cachedResults) {
        return res.json(cachedResults);
      }

      const books = await cache.getBooks();
      const results = await detectDuplicates(books);
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * Deletes a book file and its record.
   */
  async deleteBookFile(req, res, cache) {
    const { location } = req.body;
    if (!location) return res.status(400).json({ error: "Location is required" });

    try {
      const absolutePath = await getValidatedAbsolutePath(BOOKS_PATH, location);
      if (!absolutePath || !fs.existsSync(absolutePath)) {
        return res.status(404).json({ error: ERR_FILE_NOT_FOUND });
      }

      // 1. Delete physical file
      await fsPromises.unlink(absolutePath);

      // 2. Remove from local cache
      const books = await cache.getBooks();
      const index = books.findIndex((b) => b.location === location);
      if (index !== -1) {
        const book = books[index];
        books.splice(index, 1);

        // 3. Enqueue deletion from Sheets
        if (book.rowIndex) {
          writeQueue.enqueueDelete(book.rowIndex);
        }

        // 4. Save updated JSON cache and clear duplicate cache
        await cache.saveBooks();
        await clearDuplicateCache();
      }

      res.json({ message: "Book deleted successfully" });
    } catch (error) {
      console.error("[BookController] Delete error:", error.message);
      res.status(500).json({ error: error.message });
    }
  }
};

module.exports = bookController;
