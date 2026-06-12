/**
 * API Service
 * Handles all communication with the backend.
 */

export async function fetchBooksApi() {
  const response = await fetch("/api/books");
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return await response.json();
}

export async function fetchPreviewApi(rowIndex) {
  const response = await fetch(`/api/preview/${rowIndex}`);
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return await response.json();
}

export async function fetchScanStatusApi() {
  const response = await fetch("/api/scan/status");
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return await response.json();
}

export async function startScanApi(force = false) {
  const response = await fetch(`/api/scan?force=${force}`);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return await response.json();
}

export async function stopSyncApi() {
  const response = await fetch("/api/sync/stop", { method: "POST" });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return await response.json();
}

export async function fetchSyncPreviewApi() {
  const response = await fetch("/api/sync/preview");
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

export async function executeSyncApi() {
  const response = await fetch("/api/sync/execute", { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

export async function fetchDuplicatesApi() {
  const response = await fetch("/api/duplicates");
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return await response.json();
}

export async function deleteBookFileApi(location) {
  const response = await fetch("/api/books/file", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location }),
  });
  
  if (!response.ok) {
    const errData = await response.json();
    throw new Error(errData.error || "Failed to delete file");
  }
  return await response.json();
}
