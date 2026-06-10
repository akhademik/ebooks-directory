// ─── State ────────────────────────────────────────────────────────────────────
let allBooks = [];
let currentPage = 1;
const BOOKS_PER_PAGE = 25;

let sortKey = null; // 'title' | 'ext' | 'size' | 'rating'
let sortDir = "asc"; // 'asc' | 'desc'
let activeFormat = ""; // quick-filter chip

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
  maxSize: () => document.getElementById("maxSize"),
  scanBtn: () => document.getElementById("scanBtn"),
  scanIcon: () => document.getElementById("scanIcon"),
  statusArea: () => document.getElementById("statusArea"),
  statusText: () => document.getElementById("statusText"),
  scanProgress: () => document.getElementById("scanProgress"),
  progressBar: () => document.getElementById("progressBar"),
  previewModal: () => document.getElementById("previewModal"),
  modalOverlay: () => document.getElementById("modalOverlay"),
  closeModal: () => document.getElementById("closeModal"),
  previewTitle: () => document.getElementById("previewTitle"),
  previewContent: () => document.getElementById("previewContent"),
  formatChips: () => document.getElementById("formatChips"),
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  fetchBooks();
  startScan();

  EL.searchInput().addEventListener("input", resetAndRender);
  EL.typeFilter().addEventListener("change", () => {
    // Sync chip selection when dropdown changes
    activeFormat = EL.typeFilter().value;
    syncChips();
    resetAndRender();
  });
  EL.minSize().addEventListener("input", resetAndRender);
  EL.maxSize().addEventListener("input", resetAndRender);

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

function updateSortHeaders() {
  document.querySelectorAll(".th[data-sort]").forEach((th) => {
    const isSorted = th.dataset.sort === sortKey;
    th.classList.toggle("sorted", isSorted);
    const icon = th.querySelector(".sort-icon");
    if (icon) {
      icon.className = isSorted
        ? `fas fa-sort-${sortDir === "asc" ? "up" : "down"} sort-icon`
        : "fas fa-sort sort-icon";
    }
  });
  if (sortKey) {
    const labels = { title: "Title", ext: "Format", size: "Size" };
    EL.sortLabel().textContent = `Sorted by ${labels[sortKey] || sortKey} (${sortDir === "asc" ? "↑" : "↓"})`;
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
  const maxMB = parseFloat(EL.maxSize().value) || Infinity;

  let books = allBooks.filter((book) => {
    const combined =
      removeAccents(book.title) + " " + removeAccents(book.author);
    if (!queryTerms.every((t) => combined.includes(t))) return false;

    const ext = (book.location || "").split(".").pop().toLowerCase();
    if (type && ext !== type) return false;

    const sizeMB = parseFloat(book.size) || 0;
    if (sizeMB < minMB || sizeMB > maxMB) return false;

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

  if (!append) grid.innerHTML = "";

  // Update counts
  EL.resultCount().textContent = `${books.length.toLocaleString()} book${books.length !== 1 ? "s" : ""}`;
  EL.headerCount().textContent = `${allBooks.length.toLocaleString()} books total`;

  if (books.length === 0 && !append) {
    empty.classList.add("visible");
    return;
  }
  empty.classList.remove("visible");

  const start = append ? (currentPage - 1) * BOOKS_PER_PAGE : 0;
  const end = currentPage * BOOKS_PER_PAGE;
  const slice = books.slice(start, end);

  const fragment = document.createDocumentFragment();

  slice.forEach((book, i) => {
    const globalIdx = start + i + 1;
    const ext = (book.location || "").split(".").pop().toLowerCase() || "book";
    const canPreview = SUPPORTED_PREVIEW_EXTS.has(ext);

    const defaultCover = `https://ui-avatars.com/api/?name=${encodeURIComponent(book.title)}&size=100&background=1e293b&color=6366f1&bold=true&format=svg`;
    let coverUrl = defaultCover;
    if (book.cover && book.cover.startsWith("http")) {
      coverUrl = book.cover;
    } else if (book.rowIndex) {
      coverUrl = `/api/cover/${book.rowIndex}`;
    }

    const stars = renderStars(book.rating);
    const ratingVal = book.rating && book.rating !== "N/A" ? book.rating : "";
    const ratingCount = formatRatingCount(book.ratingCount);
    const ratingText = ratingVal
      ? `${ratingVal}${ratingCount ? ` (${ratingCount})` : ""}`
      : "";

    const goodreadsUrl = book.goodreadsId
      ? `https://www.goodreads.com/book/show/${book.goodreadsId}`
      : "";
    const titleHtml = goodreadsUrl
      ? `<a href="${goodreadsUrl}" target="_blank" rel="noopener" title="View on Goodreads">${escHtml(book.title)}</a>`
      : escHtml(book.title);

    // Serialize book for onclick without escaping issues
    const bookJson = JSON.stringify(book);

    const row = document.createElement("div");
    row.className = "book-row";

    row.innerHTML = `
            <div class="row-idx">${globalIdx}</div>

            <div class="book-info">
                <div class="cover-thumb" role="button" tabindex="0" aria-label="Preview ${escHtml(book.title)}" data-book-index="${escHtml(String(book.rowIndex))}">
                    <img src="${coverUrl}" alt="" loading="lazy"
                         onerror="this.onerror=null;this.src='${defaultCover}'">
                </div>
                <div class="book-text">
                    <div class="book-title">${titleHtml}</div>
                    <div class="book-author">${escHtml(book.author || "")}</div>
                    ${
                      stars
                        ? `<div class="book-rating">
                        <span class="stars">${stars}</span>
                        <span class="rating-val">${ratingText}</span>
                    </div>`
                        : ""
                    }
                </div>
            </div>

            <div>
                <span class="format-badge badge-${ext}">${ext.toUpperCase()}</span>
            </div>

            <div class="size-cell">${book.size || "—"} MB</div>

            <div class="action-cell">
                <button class="icon-btn ${canPreview ? "" : "disabled"}"
                        title="${canPreview ? "Preview" : "Preview not available for this format"}"
                        data-action="preview" data-row="${book.rowIndex}"
                        ${canPreview ? "" : 'disabled aria-disabled="true"'}>
                    <i class="fas fa-eye"></i>
                </button>
            </div>

            <div class="action-cell">
                <a class="icon-btn download" href="/api/download/${book.rowIndex}" title="Download" aria-label="Download ${escHtml(book.title)}">
                    <i class="fas fa-download"></i>
                </a>
            </div>

            ${book.status === "manual" ? '<div class="manual-tag">MANUAL</div>' : ""}
        `;

    // Attach preview handlers cleanly (avoids inline JSON injection issues)
    const previewTriggers = row.querySelectorAll(
      '[data-action="preview"], .cover-thumb',
    );
    previewTriggers.forEach((el) => {
      el.addEventListener("click", () => {
        if (canPreview) showPreview(book);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && canPreview) showPreview(book);
      });
    });

    fragment.appendChild(row);
  });

  grid.appendChild(fragment);
}

// ─── Data ─────────────────────────────────────────────────────────────────────
async function fetchBooks() {
  try {
    const response = await fetch("/api/books");
    allBooks = await response.json();
    renderBooks(getFilteredBooks());
  } catch (err) {
    console.error("Error fetching books:", err);
    showError("Could not load books. Is the server running?");
  }
}

// ─── Preview Modal ────────────────────────────────────────────────────────────
function hidePreview() {
  EL.previewModal().classList.remove("open");
  document.body.style.overflow = "";
}

// eslint-disable-next-line no-unused-vars
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
async function startScan() {
  const scanBtn = EL.scanBtn();
  const scanIcon = EL.scanIcon();
  const statusArea = EL.statusArea();
  const statusText = EL.statusText();
  const scanProgress = EL.scanProgress();
  const progressBar = EL.progressBar();

  scanBtn.disabled = true;
  scanBtn.classList.add("opacity-50", "cursor-not-allowed");
  scanIcon.classList.add("spinning");
  statusArea.classList.remove("hidden");

  let lastProcessed = -1;

  try {
    await fetch("/api/scan");
  } catch (err) {
    console.error("Scan start error:", err);
    return;
  }

  const poll = setInterval(async () => {
    try {
      const res = await fetch("/api/scan/status");
      const data = await res.json();
      const { isScanning, isEnriching, results, enrichment } = data;

      if (isScanning) {
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
          fetchBooks();
        }
      }

      if (!isScanning && !isEnriching) {
        clearInterval(poll);
        statusText.textContent = "Library sync complete";
        progressBar.style.width = "100%";
        fetchBooks();
        setTimeout(() => statusArea.classList.add("hidden"), 3000);
        scanBtn.disabled = false;
        scanBtn.classList.remove("opacity-50", "cursor-not-allowed");
        scanIcon.classList.remove("spinning");
      }
    } catch (err) {
      console.error("Poll error:", err);
    }
  }, 2000);
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
