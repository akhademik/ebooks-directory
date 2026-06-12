import {
  fetchBooksApi,
  fetchScanStatusApi,
  startScanApi,
  stopSyncApi,
  fetchSyncPreviewApi,
  executeSyncApi,
  fetchDuplicatesApi,
  deleteBookFileApi
} from "./api.service.js";

import {
  state,
  setBooks,
  setSort,
  setActiveFormat,
  toggleDuplicates,
  setDuplicateResults,
  addDeletedInSession,
  clearDeletedInSession,
  setFetchingBooks
} from "./state.manager.js";

import {
  EL,
  resetAndRender,
  loadNextPage,
  renderBooks,
  getFilteredBooks,
  syncChips,
  updateSortHeaders,
  hidePreview,
  renderSyncPreview,
  updateDuplicateBadge,
  renderDuplicates,
  hideDeleteModal,
  showError
} from "./ui.renderer.js";

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  fetchBooks();
  fetchDuplicates();
  checkScanStatus();
  
  startScan(false);

  EL.scanBtn().addEventListener("click", () => startScan(true));
  EL.syncBtn().addEventListener("click", handleSyncClick);
  EL.duplicatesBtn().addEventListener("click", toggleDuplicatesView);
  EL.confirmSync().addEventListener("click", handleConfirmSync);
  EL.cancelSync().addEventListener("click", handleCancelSync);

  EL.cancelDeleteBtn().addEventListener("click", hideDeleteModal);
  EL.confirmDeleteBtn().addEventListener("click", executeDelete);

  EL.searchInput().addEventListener("input", resetAndRender);
  EL.typeFilter().addEventListener("change", () => {
    setActiveFormat(EL.typeFilter().value);
    syncChips();
    resetAndRender();
  });
  EL.minSize().addEventListener("input", resetAndRender);

  document.querySelectorAll(".th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        setSort(state.sortKey, state.sortDir === "asc" ? "desc" : "asc");
      } else {
        setSort(key, "asc");
      }
      updateSortHeaders();
      resetAndRender();
    });
  });

  EL.formatChips().addEventListener("click", (e) => {
    const chip = e.target.closest(".stat-chip");
    if (!chip) return;
    setActiveFormat(chip.dataset.format);
    EL.typeFilter().value = state.activeFormat;
    syncChips();
    resetAndRender();
  });

  window.addEventListener("scroll", () => {
    if (window.scrollY > 500) {
      EL.jumpToTop().classList.remove("hidden");
    } else {
      EL.jumpToTop().classList.add("hidden");
    }
  }, { passive: true });

  EL.jumpToTop().addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  EL.closeModal().addEventListener("click", hidePreview);
  EL.modalOverlay().addEventListener("click", hidePreview);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hidePreview();
      hideDeleteModal();
    }
  });

  window.addEventListener(
    "scroll",
    () => {
      if (
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 400
      ) {
        loadNextPage();
      }
    },
    { passive: true },
  );
});

// ─── Data & Orchestration ───────────────────────────────────────────────────
async function fetchBooks(shouldRender = true) {
  if (state.isFetchingBooks) return;
  setFetchingBooks(true);
  try {
    setBooks(await fetchBooksApi());
    if (shouldRender && !state.isShowingDuplicates) {
      renderBooks(getFilteredBooks());
    }
  } catch (err) {
    console.error("Error fetching books:", err);
    if (shouldRender) showError("Could not load books. Is the server running?");
  } finally {
    setFetchingBooks(false);
  }
}

async function checkScanStatus() {
  try {
    const data = await fetchScanStatusApi();
    if (data.isScanning || data.isEnriching) {
      startScan(false, true);
    }
  } catch (err) {
    console.error("Error checking scan status:", err);
  }
}

async function startScan(force = false, isResuming = false) {
  const statusArea = EL.statusArea();
  const statusText = EL.statusText();
  const scanProgress = EL.scanProgress();
  const progressBar = EL.progressBar();

  statusArea.classList.add("is-active");
  let lastProcessed = -1;

  if (!isResuming) {
    try {
      await startScanApi(force);
    } catch (err) {
      console.error("Scan start error:", err);
      return;
    }
  }

  if (window._scanPoll) clearInterval(window._scanPoll);

  window._scanPoll = setInterval(async () => {
    try {
      const data = await fetchScanStatusApi();
      const { isScanning, isEnriching, isSyncing, results, enrichment } = data;

      if (isSyncing) {
        statusText.textContent = "Syncing library...";
        progressBar.style.width = "50%";
        scanProgress.textContent = "";
      } else if (isScanning) {
        const pct = results.total ? Math.round((results.processed / results.total) * 100) : 0;
        progressBar.style.width = `${pct}%`;
        scanProgress.textContent = `${results.processed} / ${results.total}`;
        statusText.textContent = `Phase 1 — Scanning…`;
      } else if (isEnriching) {
        const pct = enrichment.total ? Math.round((enrichment.current / enrichment.total) * 100) : 0;
        progressBar.style.width = `${pct}%`;
        scanProgress.textContent = `${enrichment.current} / ${enrichment.total}`;
        statusText.textContent = `Phase 2 — Goodreads: ${enrichment.currentTitle || "…"}`;

        if (enrichment.current > lastProcessed) {
          lastProcessed = enrichment.current;
          fetchBooks(false);
        }
      }

      if (!isScanning && !isEnriching) {
        clearInterval(window._scanPoll);
        window._scanPoll = null;
        statusText.textContent = "Library sync complete";
        progressBar.style.width = "100%";
        
        await fetchBooks(false);
        await fetchDuplicates(false);
        if (!state.isShowingDuplicates) {
          renderBooks(getFilteredBooks());
        }
        
        setTimeout(() => {
          if (!window._scanPoll) statusArea.classList.remove("is-active");
        }, 3000);
      }
    } catch (err) {
      console.error("Poll error:", err);
    }
  }, 2000);
}

async function handleSyncClick() {
  const modal = EL.syncModal();
  const summary = EL.syncSummary();
  const details = EL.syncDetails();
  const confirmBtn = EL.confirmSync();

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  summary.innerHTML = `<i class="fas fa-circle-notch fa-spin mr-2"></i> Scanning file system and comparing with Google Sheets...`;
  details.innerHTML = "";
  confirmBtn.classList.add("hidden");

  try {
    await stopSyncApi();
    const data = await fetchSyncPreviewApi();
    renderSyncPreview(data);
  } catch (err) {
    summary.innerHTML = `<span class="text-red-400">Error: ${err.message}</span>`;
  }
}

async function handleConfirmSync() {
  const confirmBtn = EL.confirmSync();
  const summary = EL.syncSummary();
  
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin mr-2"></i> Executing...`;
  
  try {
    await executeSyncApi();
    handleCancelSync();
    startScan(true); 
  } catch (err) {
    summary.innerHTML = `<span class="text-red-400">Execution Error: ${err.message}</span>`;
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = `Execute Sync`;
  }
}

function handleCancelSync() {
  const modal = EL.syncModal();
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  checkScanStatus();
}

async function toggleDuplicatesView() {
  const isShowing = toggleDuplicates();
  const btn = EL.duplicatesBtn();
  const activeClasses = ["bg-orange-500/20", "text-white", "border-orange-500"];
  
  if (isShowing) {
    clearDeletedInSession();
    btn.classList.add(...activeClasses);
    await fetchDuplicates();
  } else {
    btn.classList.remove(...activeClasses);
    resetAndRender();
  }
}

async function fetchDuplicates(shouldRender = true) {
  try {
    setDuplicateResults(await fetchDuplicatesApi());
    if (state.isShowingDuplicates && shouldRender) renderDuplicates();
    updateDuplicateBadge();
  } catch (err) {
    console.error("Error fetching duplicates:", err);
  }
}

async function executeDelete() {
  if (!state.pendingDeletePath) return;
  const location = state.pendingDeletePath;
  const confirmBtn = EL.confirmDeleteBtn();
  
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i> Deleting...';

  try {
    await deleteBookFileApi(location);
    addDeletedInSession(location);
    
    const elementId = `dup-${btoa(encodeURIComponent(location)).replace(/=/g, "")}`;
    const rowEl = document.getElementById(elementId);
    if (rowEl) {
      rowEl.classList.add("deleted-file");
      const titleEl = rowEl.querySelector(".text-white") || rowEl.querySelector(".text-rose-400");
      if (titleEl) {
        titleEl.classList.remove("text-white");
        titleEl.classList.add("text-rose-400");
      }
      const btn = rowEl.querySelector(".delete-file-btn");
      if (btn) {
        btn.disabled = true;
        btn.className = "px-3 py-1.5 rounded-lg delete-file-btn deleted";
        btn.innerHTML = '<i class="fas fa-check mr-1"></i> Deleted';
      }
    }

    hideDeleteModal();
    await fetchBooks(false);
    await fetchDuplicates(false);
  } catch (err) {
    console.error("Error deleting file:", err);
    alert(`Could not delete file: ${err.message}`);
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = "Permanently Delete";
  }
}
