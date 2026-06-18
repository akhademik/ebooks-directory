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
  setShowingDuplicates,
  setDuplicateResults,
  setActiveTag,
  addDeletedInSession,
  clearDeletedInSession,
  setFetchingBooks,
  setCalculatingDuplicates,
  setDuplicatePercent
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
  renderDuplicateLoading,
  hideDeleteModal,
  showError,
  updateFilters,
  syncDuplicatesBtnState
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

  EL.searchInput().addEventListener("input", () => {
    setShowingDuplicates(false);
    syncDuplicatesBtnState();
    resetAndRender();
  });
  EL.typeFilter().addEventListener("change", () => {
    setShowingDuplicates(false);
    setActiveFormat(EL.typeFilter().value);
    syncChips();
    syncDuplicatesBtnState();
    resetAndRender();
  });
  EL.tagFilter().addEventListener("change", () => {
    setShowingDuplicates(false);
    setActiveTag(EL.tagFilter().value);
    updateSortHeaders();
    syncDuplicatesBtnState();
    resetAndRender();
  });
  EL.minSize().addEventListener("input", () => {
    setShowingDuplicates(false);
    syncDuplicatesBtnState();
    resetAndRender();
  });

  document.querySelectorAll(".th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      setShowingDuplicates(false);
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        setSort(state.sortKey, state.sortDir === "asc" ? "desc" : "asc");
      } else {
        setSort(key, "asc");
      }
      updateSortHeaders();
      syncDuplicatesBtnState();
      resetAndRender();
    });
  });

  EL.formatChips().addEventListener("click", (e) => {
    const chip = e.target.closest(".stat-chip");
    if (!chip) return;
    setShowingDuplicates(false);
    setActiveFormat(chip.dataset.format);
    EL.typeFilter().value = state.activeFormat;
    syncChips();
    syncDuplicatesBtnState();
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

  // ── Mobile filter bar sync ──────────────────────────────────────────────────
  const mobileSearch = document.getElementById("mobileSearch");
  const mobileTag = document.getElementById("mobileTagFilter");
  const mobileType = document.getElementById("mobileTypeFilter");
  const mobileMinSize = document.getElementById("mobileMinSize");

  if (mobileSearch) {
    mobileSearch.addEventListener("input", () => {
      EL.searchInput().value = mobileSearch.value;
      setShowingDuplicates(false);
      syncDuplicatesBtnState();
      resetAndRender();
    });
  }
  if (mobileType) {
    mobileType.addEventListener("change", () => {
      EL.typeFilter().value = mobileType.value;
      setShowingDuplicates(false);
      setActiveFormat(mobileType.value);
      syncChips();
      syncDuplicatesBtnState();
      resetAndRender();
    });
  }
  if (mobileTag) {
    mobileTag.addEventListener("change", () => {
      EL.tagFilter().value = mobileTag.value;
      setShowingDuplicates(false);
      setActiveTag(mobileTag.value);
      updateSortHeaders();
      syncDuplicatesBtnState();
      resetAndRender();
    });
  }
  if (mobileMinSize) {
    mobileMinSize.addEventListener("input", () => {
      EL.minSize().value = mobileMinSize.value;
      setShowingDuplicates(false);
      syncDuplicatesBtnState();
      resetAndRender();
    });
  }
});

// ─── Data & Orchestration ───────────────────────────────────────────────────
async function fetchBooks(shouldRender = true) {
  if (state.isFetchingBooks) return;
  setFetchingBooks(true);
  try {
    setBooks(await fetchBooksApi());
    updateFilters();
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
      const { isScanning, isEnriching, isSyncing, results, enrichment, duplicateProgress } = data;

      if (duplicateProgress && state.isCalculatingDuplicates) {
        setDuplicatePercent(duplicateProgress.percent);
        if (state.isShowingDuplicates) {
          syncDuplicatesBtnState();
          renderDuplicateLoading();
        }
      }

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
  syncDuplicatesBtnState();

  if (isShowing) {
    clearDeletedInSession();
    if (state.isCalculatingDuplicates) {
      renderDuplicateLoading();
    } else {
      await fetchDuplicates();
    }
  } else {
    resetAndRender();
  }
}

async function fetchDuplicates(shouldRender = true) {
  if (state.isCalculatingDuplicates) return;
  const btn = EL.duplicatesBtn();
  const originalHtml = btn.innerHTML;

  try {
    setCalculatingDuplicates(true);
    if (state.isShowingDuplicates && shouldRender) {
      btn.innerHTML = `<i class="fas fa-circle-notch fa-spin mr-1"></i><span class="btn-label"> Calculating...</span>`;
      renderDuplicateLoading();
    }
    setDuplicateResults(await fetchDuplicatesApi());
    if (state.isShowingDuplicates && shouldRender) renderDuplicates();
    updateDuplicateBadge();
  } catch (err) {
    console.error("Error fetching duplicates:", err);
    if (state.isShowingDuplicates && shouldRender) {
      showError(`Failed to calculate duplicates: ${err.message}`);
    }
  } finally {
    setCalculatingDuplicates(false);
    finalizeDuplicatesUI(originalHtml);
  }
}

function finalizeDuplicatesUI(originalHtml) {
  const btn = EL.duplicatesBtn();
  if (state.isShowingDuplicates) {
    const badgeHtml = `<span id="duplicateBadge" class="hidden absolute -top-2 -right-2 px-2 py-0.5 bg-orange-600 text-white text-[10px] rounded-full">0</span>`;
    btn.innerHTML = `<i class="fas fa-copy"></i><span class="btn-label"> Duplicates</span> ${badgeHtml}`;
    updateDuplicateBadge();
  } else {
    btn.innerHTML = originalHtml;
  }
}

async function executeDelete() {
  if (!state.pendingDeletePath) return;
  const location = state.pendingDeletePath;
  const btn = EL.confirmDeleteBtn();

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i> Deleting...';

  try {
    await deleteBookFileApi(location);
    handleSuccessfulDelete(location);
    hideDeleteModal();
    await refreshDataAfterDelete();
  } catch (err) {
    console.error("Error deleting file:", err);
    alert(`Could not delete file: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Permanently Delete";
  }
}

function handleSuccessfulDelete(location) {
  addDeletedInSession(location);
  renderDuplicates();
}

async function refreshDataAfterDelete() {
  fetchBooks(false);

  try {
    const updatedResults = await fetchDuplicatesApi();
    const freshCount = updatedResults.stats.totalGroups;

    if (!state.isShowingDuplicates) {
      setDuplicateResults(updatedResults);
    }

    if (state.isShowingDuplicates) {
      renderDuplicates();
    }

    updateDuplicateBadge(freshCount);
  } catch (err) {
    console.error("Error updating duplicates after delete:", err);
  }
}