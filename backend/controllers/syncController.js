const { generateSyncPreview, performSyncAction } = require("../services/syncService");
const { setupSpreadsheetHeaders } = require("../clients/googleSheetsClient");
const { runEnrichmentLoop } = require("../services/enrichmentService");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const BOOKS_PATH = process.env.BOOKS_PATH;
const SUPPORTED_EXTENSIONS = [".pdf", ".epub", ".mobi", ".azw", ".azw3"];

/**
 * Handles the background enrichment loop.
 */
async function handleEnrichmentLoop(config) {
  const { state, cache, getScanId, currentScanId, force } = config;
  try {
    await setupSpreadsheetHeaders(SHEET_ID);
    const books = await cache.getBooks(force);
    if (getScanId() !== currentScanId) return;

    state.scanResults.total = books.length;
    
    await runEnrichmentLoop({
      sheetId: SHEET_ID,
      scanId: currentScanId,
      state,
      getBooks: () => cache.getBooks(),
      updateCache: (book) => cache.updateBook(book),
      libraryRoot: BOOKS_PATH,
      isContextValid: (id) => id === getScanId()
    });
  } catch (error) {
    console.error("[SyncController] Enrichment startup error:", error.message);
  } finally {
    if (getScanId() === currentScanId) {
      state.isScanning = false;
      state.isEnriching = false;
    }
  }
}

/**
 * Controller for synchronization and enrichment operations.
 */
const syncController = {
  /**
   * Starts the enrichment process.
   */
  async startEnrichment(req, res, { state, cache, getScanId, incrementScanId }) {
    const force = req.query.force === "true";
    if (state.isEnriching && !force) {
      return res.json({ message: "Enrichment already in progress", results: state.scanResults });
    }

    incrementScanId();
    const currentScanId = getScanId();
    state.isScanning = false;
    state.isEnriching = true;
    state.scanResults = { total: 0, processed: 0, added: 0, skipped: 0, deleted: 0, errors: 0 };

    handleEnrichmentLoop({ state, cache, getScanId, currentScanId, force });

    res.json({ message: "Enrichment started", results: state.scanResults, scanId: currentScanId });
  },

  /**
   * Stops all ongoing processes.
   */
  stopProcesses(req, res, { state, incrementScanId }) {
    incrementScanId();
    state.isScanning = false;
    state.isEnriching = false;
    state.isSyncing = false;
    res.json({ message: "Processes stopped" });
  },

  /**
   * Generates a sync preview.
   */
  async getPreview(req, res, { state, incrementScanId, setLastSyncPreview }) {
    if (state.isSyncing) return res.status(409).json({ error: "Sync already in progress" });

    try {
      incrementScanId();
      state.isSyncing = true;
      const preview = await generateSyncPreview({
        libraryRoot: BOOKS_PATH,
        sheetId: SHEET_ID,
        extensions: SUPPORTED_EXTENSIONS,
        scanPath: process.env.SCAN_PATH
      });
      setLastSyncPreview(preview);
      state.isSyncing = false;
      res.json(preview);
    } catch (error) {
      state.isSyncing = false;
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * Executes the sync based on the last generated preview.
   */
  async execute(req, res, { state, lastSyncPreview, clearLastSyncPreview, cache }) {
    if (!lastSyncPreview) return res.status(400).json({ error: "No preview found. Run preview first." });
    if (state.isSyncing) return res.status(409).json({ error: "Sync already in progress" });

    try {
      state.isSyncing = true;
      const results = await performSyncAction({
        libraryRoot: BOOKS_PATH,
        sheetId: SHEET_ID,
        previewResults: lastSyncPreview
      });
      clearLastSyncPreview();
      state.isSyncing = false;
      await cache.getBooks(true);
      res.json({ message: "Sync complete", results });
    } catch (error) {
      state.isSyncing = false;
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * Gets the current status of scanning and enrichment.
   */
  getStatus(req, res, state) {
    res.json({
      isScanning: state.isScanning,
      isEnriching: state.isEnriching,
      isSyncing: state.isSyncing,
      results: state.scanResults,
      enrichment: state.enrichment,
    });
  }
};

module.exports = syncController;
