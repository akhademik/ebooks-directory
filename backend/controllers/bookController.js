const path = require("path");
const mime = require("mime-types");
const { fetchAllBooks } = require("../clients/googleSheetsClient");
const { getValidatedAbsolutePath } = require("../services/enrichmentService");
const { getPreview } = require("../utils/preview");
const { extractEmbeddedCover } = require("../utils/cover");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
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
  async getBookPreview(req, res) {
    try {
      const rowIndex = parseInt(req.params.rowIndex);
      const books = await fetchAllBooks(SHEET_ID);
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
  async getBookCover(req, res) {
    try {
      const rowIndex = parseInt(req.params.rowIndex);
      const books = await fetchAllBooks(SHEET_ID);
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
  async downloadBook(req, res) {
    try {
      const rowIndex = parseInt(req.params.rowIndex);
      const books = await fetchAllBooks(SHEET_ID);
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
  }
};

module.exports = bookController;
