const { generateSyncPreview, performSyncAction } = require("../services/syncService");
const { setupSpreadsheetHeaders } = require("../clients/googleSheetsClient");
const { runEnrichmentLoop } = require("../services/enrichmentService");
const { invalidateOnBooksChange } = require("../services/duplicateDetector.service");
const writeQueue = require("../services/writeQueue.service");
const { resetHashWorker } = require("../services/hashService");

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

    // Fire and forget — không block response
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
    // Reset hash worker flag để lần scan tiếp theo không bị block
    resetHashWorker();
    res.json({ message: "Processes stopped" });
  },

  /**
   * Generates a sync preview.
   *
   * Flushes the writeQueue trước khi scan filesystem để tránh
   * concurrent Sheets API calls gây treo request.
   */
  async getPreview(req, res, { state, incrementScanId, setLastSyncPreview }) {
    if (state.isSyncing) return res.status(409).json({ error: "Sync already in progress" });

    try {
      incrementScanId();
      state.isSyncing = true;

      // Đợi writeQueue drain hết trước khi bắt đầu scan
      await writeQueue.flush();

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
   *
   * Thứ tự thực hiện:
   *   1. Pause writeQueue interval → tránh flush chen vào giữa
   *   2. performSyncAction         → ghi thay đổi lên Sheets
   *   3. flush() thủ công          → drain mọi thứ còn pending
   *   4. invalidateOnBooksChange() → xóa duplicate cache cũ
   *   5. cache.getBooks(true)      → refresh book list từ Sheets
   *   6. resumeInterval()          → bật lại auto-flush
   *   7. state.isSyncing = false   → SAU KHI mọi thứ xong
   */
  async execute(req, res, { state, lastSyncPreview, clearLastSyncPreview, cache }) {
    if (!lastSyncPreview) return res.status(400).json({ error: "No preview found. Run preview first." });
    if (state.isSyncing) return res.status(409).json({ error: "Sync already in progress" });

    try {
      state.isSyncing = true;

      // 1. Pause auto-flush để tránh concurrent Sheets API calls
      writeQueue.pauseInterval();

      // 2. Thực hiện sync
      const results = await performSyncAction({
        libraryRoot: BOOKS_PATH,
        sheetId: SHEET_ID,
        previewResults: lastSyncPreview
      });
      clearLastSyncPreview();

      // 3. Drain writeQueue thủ công — đảm bảo mọi update đã lên Sheets
      await writeQueue.flush();

      // 4. Library đã thay đổi → xóa duplicate cache cũ
      //    Lần sau user vào tab Duplicates sẽ tự rescan
      await invalidateOnBooksChange();

      // 5. Refresh book list từ Sheets
      await cache.getBooks(true);

      // 6. Bật lại auto-flush
      writeQueue.resumeInterval();

      // 7. Chỉ báo done SAU KHI mọi thứ thực sự xong
      state.isSyncing = false;
      res.json({ message: "Sync complete", results });
    } catch (error) {
      // Đảm bảo interval luôn được resume dù có lỗi
      writeQueue.resumeInterval();
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
      duplicateProgress: state.duplicateProgress,
    });
  }
};

module.exports = syncController;