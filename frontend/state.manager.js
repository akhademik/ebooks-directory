/**
 * State Manager
 * Centralized store for application state.
 */

export const state = {
  allBooks: [],
  currentPage: 1,
  BOOKS_PER_PAGE: 25,
  
  sortKey: null, // 'title' | 'ext' | 'size' | 'rating' | 'tags'
  sortDir: "asc", // 'asc' | 'desc'
  activeFormat: "", // quick-filter chip
  
  isShowingDuplicates: false,
  duplicateResults: null,
  duplicatesPage: 1,
  isCalculatingDuplicates: false,
  duplicatePercent: 0,
  deletedInSession: new Set(), // Tracks deletions in current view session
  
  SUPPORTED_PREVIEW_EXTS: new Set(["pdf", "epub"]),
  
  isFetchingBooks: false,
  pendingDeletePath: null
};

// ─── Mutations ────────────────────────────────────────────────────────────────

export function setBooks(books) {
  state.allBooks = books;
}

export function resetPagination() {
  state.currentPage = 1;
}

export function incrementPage() {
  state.currentPage++;
}

export function setSort(key, dir) {
  state.sortKey = key;
  state.sortDir = dir;
}

export function setActiveFormat(format) {
  state.activeFormat = format;
}

export function setActiveTag(tag) {
  state.activeTag = tag;
}

export function toggleDuplicates() {
  state.isShowingDuplicates = !state.isShowingDuplicates;
  return state.isShowingDuplicates;
}

export function setShowingDuplicates(isShowing) {
  state.isShowingDuplicates = isShowing;
}

export function resetDuplicatesPagination() {
  state.duplicatesPage = 1;
}

export function incrementDuplicatesPage() {
  state.duplicatesPage++;
}

export function setDuplicateResults(results) {
  state.duplicateResults = results;
}

export function setCalculatingDuplicates(isCalculating) {
  state.isCalculatingDuplicates = isCalculating;
}

export function setDuplicatePercent(percent) {
  state.duplicatePercent = percent;
}

export function addDeletedInSession(path) {
  state.deletedInSession.add(path);
}

export function clearDeletedInSession() {
  state.deletedInSession.clear();
}

export function setFetchingBooks(isFetching) {
  state.isFetchingBooks = isFetching;
}

export function setPendingDeletePath(path) {
  state.pendingDeletePath = path;
}
