// ─── State ────────────────────────────────────────────────────────────────────
let allBooks = [];
let currentPage = 1;
const BOOKS_PER_PAGE = 25;

let sortKey = null; // 'title' | 'ext' | 'size' | 'rating'
let sortDir = "asc"; // 'asc' | 'desc'
let activeFormat = ""; // quick-filter chip

let isShowingDuplicates = false;
let duplicateResults = null;

const SUPPORTED_PREVIEW_EXTS = new Set(["pdf", "epub"]);

// ─── Element refs ─────────────────────────────────────────────────────────────
const EL = {
  bookGrid: () => document.getElementById("bookGrid"),
  emptyState: () => document.getElementById("emptyState"),
  resultCount: () => document.getElementById("resultCount"),
  sortLabel: () => document.getElementById("sortLabel"),
  headerCount: () => document.getElementById("headerCount"),
  searchInput: () => document.getElementById("searchInput"),
  typeFilter: () => document.getElementById("typeFilter"),
  minSize: () => document.getElementById("minSize"),
  syncBtn: () => document.getElementById("syncBtn"),
  scanBtn: () => document.getElementById("scanBtn"),
  duplicatesBtn: () => document.getElementById("duplicatesBtn"),
  duplicateBadge: () => document.getElementById("duplicateBadge"),
  statusArea: () => document.getElementById("statusArea"),
  statusText: () => document.getElementById("statusText"),
  scanProgress: () => document.getElementById("scanProgress"),
  progressBar: () => document.getElementById("progressBar"),
  previewModal: () => document.getElementById("previewModal"),
  syncModal: () => document.getElementById("syncModal"),
  syncSummary: () => document.getElementById("syncSummary"),
  syncDetails: () => document.getElementById("syncDetails"),
  cancelSync: () => document.getElementById("cancelSync"),
  confirmSync: () => document.getElementById("confirmSync"),
  modalOverlay: () => document.getElementById("modalOverlay"),
  closeModal: () => document.getElementById("closeModal"),
  previewTitle: () => document.getElementById("previewTitle"),
  previewContent: () => document.getElementById("previewContent"),
  formatChips: () => document.getElementById("formatChips"),
  jumpToTop: () => document.getElementById("jumpToTop"),
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  fetchBooks();
  fetchDuplicates();
  checkScanStatus();
  
  // By default, start a normal scan on load. 
  // If one is already running, startScan will just resume polling.
  startScan(false);

  EL.scanBtn().addEventListener("click", () => startScan(true));
  EL.syncBtn().addEventListener("click", handleSyncClick);
  EL.duplicatesBtn().addEventListener("click", toggleDuplicatesView);
  EL.confirmSync().addEventListener("click", handleConfirmSync);
  EL.cancelSync().addEventListener("click", handleCancelSync);

  EL.searchInput().addEventListener("input", resetAndRender);
  EL.typeFilter().addEventListener("change", () => {
    // Sync chip selection when dropdown changes
    activeFormat = EL.typeFilter().value;
    syncChips();
    resetAndRender();
  });
  EL.minSize().addEventListener("input", resetAndRender);

  // Sort headers
  document.querySelectorAll(".th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = "asc";
      }
      updateSortHeaders();
      resetAndRender();
    });
  });

  // Format chips
  EL.formatChips().addEventListener("click", (e) => {
    const chip = e.target.closest(".stat-chip");
    if (!chip) return;
    activeFormat = chip.dataset.format;
    EL.typeFilter().value = activeFormat;
    syncChips();
    resetAndRender();
  });

  // Jump to top
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

  // Modal
  EL.closeModal().addEventListener("click", hidePreview);
  EL.modalOverlay().addEventListener("click", hidePreview);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hidePreview();
  });

  // Infinite scroll
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getInitials(title) {
  if (!title) return "";
  const clean = removeAccents(title).toUpperCase();
  const words = clean.split(/[\s~/\\-]+/).filter(w => {
    return w && /^[A-Z0-9]/.test(w);
  });
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]);
  }
  return words.length > 0 ? words[0][0] : "";
}

function removeAccents(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
    .toLowerCase();
}

function renderStars(ratingStr) {
  const n = parseFloat(ratingStr);
  if (isNaN(n)) return "";
  const full = Math.floor(n);
  const half = n - full >= 0.4 ? 1 : 0;
  const empty = 5 - full - half;
  return "★".repeat(full) + (half ? "½" : "") + "☆".repeat(empty);
}

function formatRatingCount(countStr) {
  if (!countStr) return "";
  const n = parseInt((countStr + "").replace(/,/g, ""), 10);
  if (isNaN(n)) return countStr;
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return n.toString();
}

function syncChips() {
  document.querySelectorAll("#formatChips .stat-chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.format === activeFormat);
  });
}

function updateFilters() {
  const extensions = new Set();
  allBooks.forEach((b) => {
    const ext = (b.location || "").split(".").pop().toLowerCase();
    if (ext) extensions.add(ext);
  });

  const sortedExts = Array.from(extensions).sort();

  // Update chips
  const chipsContainer = EL.formatChips();
  const currentFormat = activeFormat;

  chipsContainer.innerHTML = `<button class="stat-chip ${!currentFormat ? "active" : ""}" data-format="">All</button>`;
  
  sortedExts.forEach((ext) => {
    chipsContainer.innerHTML += `<button class="stat-chip ${currentFormat === ext ? "active" : ""}" data-format="${ext}">${ext.toUpperCase()}</button>`;
  });

  // Update dropdown
  const select = EL.typeFilter();
  select.innerHTML = '<option value="">All formats</option>';
  sortedExts.forEach((ext) => {
    const opt = document.createElement("option");
    opt.value = ext;
    opt.textContent = ext.toUpperCase();
    if (ext === currentFormat) opt.selected = true;
    select.appendChild(opt);
  });
}

function updateSortHeaders() {
  document.querySelectorAll(".th[data-sort]").forEach((th) => {
    const isSorted = th.dataset.sort === sortKey;
    th.classList.toggle("sorted", isSorted);
    const icon = th.querySelector(".sort-icon");
    if (icon) {
      if (isSorted) {
        const arrow = sortDir === "asc" ? "up" : "down";
        icon.className = `fas fa-sort-${arrow} sort-icon`;
      } else {
        icon.className = "fas fa-sort sort-icon";
      }
    }
  });
  if (sortKey) {
    const labels = { title: "Title", ext: "Format", size: "Size" };
    const dirArrow = sortDir === "asc" ? "↑" : "↓";
    EL.sortLabel().textContent = `Sorted by ${labels[sortKey] || sortKey} (${dirArrow})`;
  } else {
    EL.sortLabel().textContent = "";
  }
}

// ─── Filtering & Sorting ──────────────────────────────────────────────────────
function getFilteredBooks() {
  const rawQuery = removeAccents(EL.searchInput().value);
  const queryTerms = rawQuery.split(/\s+/).filter(Boolean);
  const type = (EL.typeFilter().value || activeFormat).toLowerCase();
  const minMB = parseFloat(EL.minSize().value) || 0;

  let books = allBooks.filter((book) => {
    const combined =
      removeAccents(book.title) + " " + removeAccents(book.author);
    if (!queryTerms.every((t) => combined.includes(t))) return false;

    const ext = (book.location || "").split(".").pop().toLowerCase();
    if (type && ext !== type) return false;

    const sizeMB = parseFloat(book.size) || 0;
    if (sizeMB < minMB) return false;

    return true;
  });

  if (sortKey) {
    books = [...books].sort((a, b) => {
      let va, vb;
      if (sortKey === "title") {
        va = removeAccents(a.title);
        vb = removeAccents(b.title);
      } else if (sortKey === "ext") {
        va = (a.location || "").split(".").pop().toLowerCase();
        vb = (b.location || "").split(".").pop().toLowerCase();
      } else if (sortKey === "size") {
        va = parseFloat(a.size) || 0;
        vb = parseFloat(b.size) || 0;
      }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }

  return books;
}

// ─── Render Helpers ───────────────────────────────────────────────────────────
function updateCountLabels(filteredCount, totalCount) {
  const totalStr = totalCount.toLocaleString();
  const filteredStr = filteredCount.toLocaleString();

  EL.resultCount().textContent = `${filteredStr} book${filteredCount !== 1 ? "s" : ""}`;

  if (filteredCount === totalCount) {
    EL.headerCount().textContent = `${totalStr} books`;
  } else {
    EL.headerCount().textContent = `${filteredStr} / ${totalStr} books`;
  }
}

function getBookMetadata(book) {
  const ext = (book.location || "").split(".").pop().toLowerCase() || "book";
  const canPreview = SUPPORTED_PREVIEW_EXTS.has(ext);
  const initials = getInitials(book.title);
  const stars = renderStars(book.rating);
  const ratingVal = book.rating && book.rating !== "N/A" ? book.rating : "";
  const ratingCount = formatRatingCount(book.ratingCount);

  let ratingText = "";
  if (ratingVal) {
    ratingText = ratingVal + (ratingCount ? ` (${ratingCount})` : "");
  }

  let coverUrl = "";
  if (book.cover && book.cover.startsWith("http")) {
    coverUrl = book.cover;
  } else if (book.rowIndex) {
    coverUrl = `/api/cover/${book.rowIndex}`;
  }

  return { ext, canPreview, initials, stars, ratingText, coverUrl };
}

function createBookRow(book, displayIndex) {
  const row = document.createElement("div");
  row.className = "book-row";
  row.dataset.rowIndex = book.rowIndex;
  updateRowContent({ row, book, displayIndex });
  return row;
}

function updateRowContent({ row, book, displayIndex }) {
  const metadata = getBookMetadata(book);
  const newInnerHtml = generateBookRowInnerHtml({
    book,
    displayIndex,
    metadata,
    row,
  });

  // Only update if content actually changed to avoid unnecessary re-paints
  if (row.innerHTML !== newInnerHtml) {
    row.innerHTML = newInnerHtml;
    attachRowEventListeners(row, book, metadata.canPreview);
  }
}

function generateBookRowInnerHtml({ book, displayIndex, metadata, row }) {
  const { ext, initials, stars, ratingText, coverUrl } = metadata;
  const goodreadsUrl = book.goodreadsId ? `https://www.goodreads.com/book/show/${book.goodreadsId}` : "";
  const titleHtml = goodreadsUrl
    ? `<a href="${goodreadsUrl}" target="_blank" rel="noopener" title="View on Goodreads">${escHtml(book.title)}</a>`
    : escHtml(book.title);

  const imgEl = row.querySelector("img");
  const isLoaded = imgEl && imgEl.classList.contains("loaded");
  const imgClass = isLoaded ? "loaded" : "";

  return `
    <div class="row-idx">${displayIndex}</div>
    <div class="book-info">
        <div class="cover-thumb" role="button" tabindex="0" aria-label="Preview ${escHtml(book.title)}" 
             data-book-index="${escHtml(String(book.rowIndex))}" data-letters="${escHtml(initials)}">
            ${coverUrl ? `<img src="${coverUrl}" alt="" loading="lazy" class="${imgClass}" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : ""}
        </div>
        <div class="book-text">
            <div class="book-title">${titleHtml}</div>
            <div class="book-author">
              ${escHtml(book.author || "")}
              ${book.year && book.year !== "N/A" ? `<span class="book-year">(${escHtml(book.year)})</span>` : ""}
            </div>
            ${stars ? `<div class="book-rating"><span class="stars">${stars}</span><span class="rating-val">${ratingText}</span></div>` : ""}
        </div>
    </div>
    <div><span class="format-badge badge-${ext}">${ext.toUpperCase()}</span></div>
    <div class="size-cell">${book.size || "—"} MB</div>
    <div class="action-cell">
        <button class="icon-btn ${metadata.canPreview ? "" : "disabled"}" title="${metadata.canPreview ? "Preview" : "Preview not available"}"
                data-action="preview" ${metadata.canPreview ? "" : 'disabled aria-disabled="true"'}>
            <i class="fas fa-eye"></i>
        </button>
    </div>
    <div class="action-cell">
        <a class="icon-btn download" href="/api/download/${book.rowIndex}" title="Download"><i class="fas fa-download"></i></a>
    </div>
    ${book.status === "manual" ? '<div class="manual-tag">MANUAL</div>' : ""}
  `;
}

function attachRowEventListeners(row, book, canPreview) {
  const previewTriggers = row.querySelectorAll('[data-action="preview"], .cover-thumb');
  previewTriggers.forEach((el) => {
    el.addEventListener("click", () => {
      if (canPreview) showPreview(book);
    });
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function resetAndRender() {
  currentPage = 1;
  renderBooks(getFilteredBooks());
}

function loadNextPage() {
  const filtered = getFilteredBooks();
  if (currentPage * BOOKS_PER_PAGE >= filtered.length) return;
  currentPage++;
  renderBooks(filtered, true);
}

function renderBooks(books, append = false) {
  const grid = EL.bookGrid();
  const empty = EL.emptyState();

  updateCountLabels(books.length, allBooks.length);

  if (books.length === 0 && !append) {
    grid.innerHTML = "";
    empty.classList.add("visible");
    return;
  }
  empty.classList.remove("visible");

  const start = append ? (currentPage - 1) * BOOKS_PER_PAGE : 0;
  const end = currentPage * BOOKS_PER_PAGE;
  const slice = books.slice(start, end);

  if (append) {
    const fragment = document.createDocumentFragment();
    slice.forEach((book, i) => fragment.appendChild(createBookRow(book, start + i + 1)));
    grid.appendChild(fragment);
  } else {
    // Smart sync of the grid to prevent jitter
    const currentRows = Array.from(grid.children);
    
    // 1. Remove excess rows
    if (currentRows.length > slice.length) {
      for (let i = slice.length; i < currentRows.length; i++) {
        currentRows[i].remove();
      }
    }

    // 2. Update or add rows
    slice.forEach((book, i) => {
      const displayIndex = start + i + 1;
      const existingRow = currentRows[i];

      if (existingRow) {
        if (existingRow.dataset.rowIndex === String(book.rowIndex)) {
          updateRowContent({ row: existingRow, book, displayIndex });
        } else {
          grid.replaceChild(createBookRow(book, displayIndex), existingRow);
        }
      } else {
        grid.appendChild(createBookRow(book, displayIndex));
      }
    });
  }
}

// ─── Data ─────────────────────────────────────────────────────────────────────
let isFetchingBooks = false;
async function fetchBooks(shouldRender = true) {
  if (isFetchingBooks) return;
  isFetchingBooks = true;
  try {
    const response = await fetch("/api/books");
    allBooks = await response.json();
    updateFilters();
    if (shouldRender && !isShowingDuplicates) {
      renderBooks(getFilteredBooks());
    }
  } catch (err) {
    console.error("Error fetching books:", err);
    if (shouldRender) showError("Could not load books. Is the server running?");
  } finally {
    isFetchingBooks = false;
  }
}

// ─── Preview Modal ────────────────────────────────────────────────────────────
function hidePreview() {
  EL.previewModal().classList.remove("open");
  document.body.style.overflow = "";
}

async function showPreview(book) {
  const modal = EL.previewModal();
  const title = EL.previewTitle();
  const content = EL.previewContent();

  title.textContent = book.title;
  content.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 0;color:#6366f1;">
            <i class="fas fa-circle-notch fa-spin" style="font-size:28px;margin-bottom:14px;"></i>
            <p style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#475569;">Loading preview…</p>
        </div>`;

  modal.classList.add("open");
  document.body.style.overflow = "hidden";

  try {
    const res = await fetch(`/api/preview/${book.rowIndex}`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();

    if (data.type === "pdf") {
      const imgsHtml = data.images
        .map(
          (src) =>
            `<div style="background:#fff;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.06);">
                    <img src="${src}" style="width:100%;height:auto;display:block;" loading="lazy">
                </div>`,
        )
        .join("");
      content.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:24px;max-width:780px;margin:0 auto;">
                    ${imgsHtml}
                    <div style="padding:48px 0;text-align:center;color:#334155;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;border-top:1px solid rgba(255,255,255,0.05);">
                        End of preview
                    </div>
                </div>`;
    } else if (data.type === "epub") {
      const chaptersHtml = data.chapters
        .map(
          (ch) =>
            `<div style="margin-bottom:40px;" class="epub-preview-content">${ch.content}</div>`,
        )
        .join("");
      content.innerHTML = `
                <div style="max-width:680px;margin:0 auto;">
                    ${chaptersHtml}
                    <div style="padding:48px 0;text-align:center;color:#334155;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;border-top:1px solid rgba(255,255,255,0.05);">
                        End of preview
                    </div>
                </div>`;
    }
  } catch (err) {
    content.innerHTML = `
            <div style="text-align:center;padding:80px 0;color:#f87171;">
                <i class="fas fa-exclamation-circle" style="font-size:32px;opacity:0.3;display:block;margin-bottom:16px;"></i>
                <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Preview failed: ${escHtml(err.message.toUpperCase())}</p>
            </div>`;
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────
async function checkScanStatus() {
  try {
    const res = await fetch("/api/scan/status");
    const data = await res.json();
    if (data.isScanning || data.isEnriching) {
      startScan(false, true); // Resume polling without triggering a new scan
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

  // Button remains enabled so user can click Force Scan anytime
  statusArea.classList.add("is-active");

  let lastProcessed = -1;

  if (!isResuming) {
    try {
      const res = await fetch(`/api/scan?force=${force}`);
      const initialData = await res.json();
      
      // If a scan was already running and we didn't force, 
      // just ensure we are polling.
      if (initialData.message === "Scan already in progress" && !force) {
        // Already polling or will be handled by checkScanStatus logic
      }
    } catch (err) {
      console.error("Scan start error:", err);
      return;
    }
  }

  // Clear any existing poll to avoid duplicates
  if (window._scanPoll) clearInterval(window._scanPoll);

  window._scanPoll = setInterval(async () => {
    try {
      const res = await fetch("/api/scan/status");
      const data = await res.json();
      const { isScanning, isEnriching, isSyncing, results, enrichment } = data;

      if (isSyncing) {
        statusText.textContent = "Syncing library...";
        progressBar.style.width = "50%"; // Indeterminate-ish
        scanProgress.textContent = "";
      } else if (isScanning) {
        const pct = results.total
          ? Math.round((results.processed / results.total) * 100)
          : 0;
        progressBar.style.width = `${pct}%`;
        scanProgress.textContent = `${results.processed} / ${results.total}`;
        statusText.textContent = `Phase 1 — Scanning…`;
      } else if (isEnriching) {
        const pct = enrichment.total
          ? Math.round((enrichment.current / enrichment.total) * 100)
          : 0;
        progressBar.style.width = `${pct}%`;
        scanProgress.textContent = `${enrichment.current} / ${enrichment.total}`;
        statusText.textContent = `Phase 2 — Goodreads: ${enrichment.currentTitle || "…"}`;

        if (enrichment.current > lastProcessed) {
          lastProcessed = enrichment.current;
          fetchBooks(false); // Fetch data in background without re-rendering
        }
      }

      if (!isScanning && !isEnriching) {
        clearInterval(window._scanPoll);
        window._scanPoll = null;
        statusText.textContent = "Library sync complete";
        progressBar.style.width = "100%";
        
        // Task 3 Fix: Don't overwrite grid if user is looking at duplicates
        await fetchBooks(false);
        await fetchDuplicates();
        if (!isShowingDuplicates) {
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

// ─── Sync Workflow ───────────────────────────────────────────────────────────
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
    // 1. Stop any active processes first
    await fetch("/api/sync/stop", { method: "POST" });
    
    // 2. Get the preview
    const res = await fetch("/api/sync/preview");
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    
    renderSyncPreview(data);
  } catch (err) {
    summary.innerHTML = `<span class="text-red-400">Error: ${err.message}</span>`;
  }
}

function renderSyncPreview(data) {
  const summary = EL.syncSummary();
  const details = EL.syncDetails();
  const confirmBtn = EL.confirmSync();

  const totalChanges =
    data.toAdd.length + data.toDelete.length + data.duplicateRows.length;

  if (totalChanges === 0) {
    summary.innerHTML = `✨ Your library is already in sync. <br><span class="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Scope: ${escHtml(data.scanScope)}</span>`;
    confirmBtn.classList.add("hidden");
    return;
  }

  summary.innerHTML = `Found <span class="text-white font-bold">${totalChanges}</span> changes in <span class="text-indigo-400 font-bold">${escHtml(data.scanScope)}</span>. Please review before executing.`;
  confirmBtn.classList.remove("hidden");

  details.innerHTML = generateSyncDetailsHtml(data);
}

function generateSyncDetailsHtml(data) {
  let html = "";

  if (data.toAdd.length > 0) {
    html += generateSyncSectionHtml({
      title: "To Add",
      count: data.toAdd.length,
      items: data.toAdd,
      colorClass: "text-emerald-500",
      iconClass: "fa-plus-circle",
    });
  }

  if (data.toDelete.length > 0) {
    html += generateSyncSectionHtml({
      title: "To Delete",
      count: data.toDelete.length,
      items: data.toDelete,
      colorClass: "text-rose-500",
      iconClass: "fa-minus-circle",
    });
  }

  if (data.duplicateRows.length > 0) {
    html += `
      <div class="text-xs text-amber-400 font-bold bg-amber-400/10 border border-amber-400/20 p-3 rounded-lg flex items-center gap-3">
        <i class="fas fa-exclamation-triangle"></i>
        <span>Found ${data.duplicateRows.length} duplicate entries in the Sheet that will be cleaned up.</span>
      </div>`;
  }

  return html;
}

function generateSyncSectionHtml({
  title,
  count,
  items,
  colorClass,
  iconClass,
}) {
  const MAX_VISIBLE_ITEMS = 10;
  const visibleItems = items.slice(0, MAX_VISIBLE_ITEMS);
  const remainingCount = items.length - MAX_VISIBLE_ITEMS;

  const itemsHtml = visibleItems
    .map(
      (item) =>
        `<div class="text-xs text-slate-300 truncate">${escHtml(item.title)}</div>`,
    )
    .join("");

  const footerHtml =
    remainingCount > 0
      ? `<div class="text-[10px] text-slate-500 font-bold italic pt-1">... and ${remainingCount} more</div>`
      : "";

  return `
    <div>
      <div class="text-[10px] font-bold ${colorClass} uppercase tracking-widest mb-2 flex items-center gap-2">
        <i class="fas ${iconClass}"></i> ${title} (${count})
      </div>
      <div class="bg-slate-900/50 rounded-lg border border-white/5 p-3 space-y-1">
        ${itemsHtml}
        ${footerHtml}
      </div>
    </div>`;
}

async function handleConfirmSync() {
  const confirmBtn = EL.confirmSync();
  const summary = EL.syncSummary();
  
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin mr-2"></i> Executing...`;
  
  try {
    const res = await fetch("/api/sync/execute", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    
    // Close modal and start a normal scan (which will refresh UI and start enrichment)
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
  // Restart status polling if needed
  checkScanStatus();
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showError(msg) {
  EL.bookGrid().innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:80px 0;color:#f87171;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
            ${escHtml(msg)}
        </div>`;
}

// ─── Duplicates View ─────────────────────────────────────────────────────────
async function toggleDuplicatesView() {
  isShowingDuplicates = !isShowingDuplicates;
  const btn = EL.duplicatesBtn();
  
  if (isShowingDuplicates) {
    btn.classList.add("bg-orange-500/20", "text-white", "border-orange-500");
    await fetchDuplicates();
  } else {
    btn.classList.remove("bg-orange-500/20", "text-white", "border-orange-500");
    resetAndRender();
  }
}

async function fetchDuplicates() {
  try {
    const res = await fetch("/api/duplicates");
    duplicateResults = await res.json();
    if (isShowingDuplicates) renderDuplicates();
    updateDuplicateBadge();
  } catch (err) {
    console.error("Error fetching duplicates:", err);
  }
}

function updateDuplicateBadge() {
  const badge = EL.duplicateBadge();
  const total = duplicateResults ? duplicateResults.stats.totalGroups : 0;
  if (total > 0) {
    badge.textContent = total;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function renderDuplicates() {
  if (!isShowingDuplicates) return;
  
  const grid = EL.bookGrid();
  const empty = EL.emptyState();
  
  grid.innerHTML = "";
  
  const { confirmed, probable, possible, stats } = duplicateResults;
  
  EL.resultCount().textContent = `Found ${stats.totalGroups} duplicate groups (${stats.totalWastedFormatted} wasted)`;
  
  if (stats.totalGroups === 0) {
    empty.classList.add("visible");
    return;
  }
  empty.classList.remove("visible");

  renderDuplicateSection("Confirmed Duplicates", confirmed, "bg-rose-500/10 text-rose-500 border-rose-500/20");
  renderDuplicateSection("Probable Duplicates", probable, "bg-amber-500/10 text-amber-500 border-amber-500/20");
  renderDuplicateSection("Possible Duplicates", possible, "bg-orange-500/10 text-orange-500 border-orange-500/20");
}

function renderDuplicateSection(title, groups, badgeClass) {
  if (groups.length === 0) return;
  
  const grid = EL.bookGrid();
  
  const sectionHeader = document.createElement("div");
  sectionHeader.className = "col-span-full mt-8 mb-4 flex items-center gap-3";
  sectionHeader.innerHTML = `
    <span class="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest ${badgeClass}">${title}</span>
    <div class="h-px flex-1 bg-white/5"></div>
  `;
  grid.appendChild(sectionHeader);
  
  groups.forEach(group => {
    const groupEl = document.createElement("div");
    groupEl.className = "col-span-full bg-slate-900/40 rounded-2xl border border-white/5 p-4 mb-4";
    
    groupEl.innerHTML = `
      <div class="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-3 flex items-center justify-between">
        <span>Group: ${escHtml(group.key)}</span>
        <span>${group.files.length} files</span>
      </div>
      <div class="space-y-1" id="group-${group.key}"></div>
    `;
    
    const filesContainer = groupEl.querySelector(".space-y-1");
    group.files.forEach(file => {
      const fileEl = document.createElement("div");
      fileEl.className = "flex items-center justify-between py-2 border-b border-white/5 last:border-0 group";
      fileEl.innerHTML = `
        <div class="flex-1 min-w-0 pr-4">
          <div class="text-xs text-white font-medium truncate" title="${escHtml(file.path)}">${escHtml(file.path)}</div>
          <div class="text-[10px] text-slate-500 mt-0.5">${file.size} MB • ${file.ext.toUpperCase()}</div>
        </div>
        <button class="px-3 py-1.5 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white text-[10px] font-bold uppercase transition-all opacity-0 group-hover:opacity-100 delete-file-btn">
          <i class="fas fa-trash-alt mr-1"></i> Delete
        </button>
      `;
      
      fileEl.querySelector(".delete-file-btn").addEventListener("click", () => handleDeleteFile(file.path));
      filesContainer.appendChild(fileEl);
    });
    
    grid.appendChild(groupEl);
  });
}

async function handleDeleteFile(location) {
  if (!confirm(`Delete permanently: ${location}?\nThis action cannot be undone.`)) return;
  
  try {
    const res = await fetch("/api/books/file", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location })
    });
    
    if (res.ok) {
      // Optimistically update UI or just re-fetch
      await fetchBooks();
      await fetchDuplicates();
    } else {
      const err = await res.json();
      alert(`Error: ${err.error}`);
    }
  } catch (err) {
    console.error("Error deleting file:", err);
    alert("Could not delete file.");
  }
}
