const express = require("express");
const bookController = require("../controllers/bookController");
const syncController = require("../controllers/syncController");

/**
 * Configures the API routes for the application.
 */
function createApiRouter({ state, cache, scanContext }) {
  const router = express.Router();

  // Book routes
  router.get("/books", (req, res) => bookController.getAllBooks(req, res, cache));
  router.get("/preview/:rowIndex", (req, res) => bookController.getBookPreview(req, res));
  router.get("/cover/:rowIndex", (req, res) => bookController.getBookCover(req, res));
  router.get("/download/:rowIndex", (req, res) => bookController.downloadBook(req, res));
  router.get("/duplicates", (req, res) => bookController.getDuplicates(req, res, cache));
  router.delete("/books/file", (req, res) => bookController.deleteBookFile(req, res, cache));

  // Sync and Enrichment routes
  router.get("/scan", (req, res) => syncController.startEnrichment(req, res, {
    state,
    cache,
    getScanId: scanContext.getScanId,
    incrementScanId: scanContext.incrementScanId
  }));
  
  router.post("/sync/stop", (req, res) => syncController.stopProcesses(req, res, {
    state,
    incrementScanId: scanContext.incrementScanId
  }));
  
  router.get("/sync/preview", (req, res) => syncController.getPreview(req, res, {
    state,
    incrementScanId: scanContext.incrementScanId,
    setLastSyncPreview: scanContext.setLastSyncPreview
  }));
  
  router.post("/sync/execute", (req, res) => syncController.execute(req, res, {
    state,
    lastSyncPreview: scanContext.getLastSyncPreview(),
    clearLastSyncPreview: scanContext.clearLastSyncPreview,
    cache
  }));
  
  router.get("/scan/status", (req, res) => syncController.getStatus(req, res, state));

  return router;
}

module.exports = createApiRouter;
