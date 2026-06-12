const path = require("path");
const fs = require("fs");
const { fetchMetadata } = require("../clients/goodreadsClient");

const BYTES_PER_MB = 1024 * 1024;

/**
 * Parses a filename to extract title and author.
 */
function parseFilename(filename) {
  const extension = path.extname(filename);
  let name = path.basename(filename, extension);

  // 1. Remove common garbage like [EPUB], (2023), etc.
  name = name
    .replace(/\[[^\]]{0,500}\]/g, "")
    .replace(/\([^)]{0,500}\)/g, "")
    .trim();

  // 2. Strip leading numbers like "01. ", "1 - ", "123 "
  name = name.replace(/^\d+[\s.-]+/, "").trim();

  // 3. Replace underscores or multiple dots with spaces
  name = name.replace(/[._]/g, " ").replace(/\s+/g, " ").trim();

  let title = name;
  let author = "Unknown";

  // 4. Handle "Title - Author" or "Author - Title"
  if (name.includes(" - ")) {
    const parts = name.split(" - ");
    title = parts[0].trim();
    author = parts[1].trim();
  }

  return { title, author, extension };
}

/**
 * Fast function to get basic info from filename + file stats.
 */
function getBasicBookInfo(filename, relativePath, absolutePath) {
  const parsed = parseFilename(filename);
  const stats = fs.statSync(absolutePath);
  const sizeInMB = (stats.size / BYTES_PER_MB).toFixed(2);

  return {
    title: parsed.title,
    author: parsed.author,
    year: "N/A",
    rating: "N/A",
    ratingCount: "",
    size: sizeInMB,
    cover: null,
    source: "Filename Parser",
    extension: parsed.extension,
    location: relativePath,
    goodreadsCheck: "No",
    goodreadsId: "",
  };
}

/**
 * Enriches book metadata using Goodreads.
 */
async function enrichBookMetadata({ filename, location, goodreadsId, currentMetadata }) {
  const baseInfo = (currentMetadata && currentMetadata.title)
    ? currentMetadata
    : { ...currentMetadata, ...parseFilename(filename) };

  const metadata = {
    ...baseInfo,
    location,
    goodreadsCheck: "Yes",
    goodreadsId: goodreadsId || baseInfo.goodreadsId,
  };

  const authorArg = baseInfo.author !== "Unknown" ? baseInfo.author : "";
  const result = await fetchMetadata(baseInfo.title, authorArg, metadata.goodreadsId);

  if (result && !result.notFound) {
    return {
      ...metadata,
      title: result.title,
      author: result.author || baseInfo.author,
      year: result.year || "N/A",
      rating: result.rating || "N/A",
      ratingCount: result.ratingCount || "",
      source: "Goodreads",
      goodreadsId: result.goodreadsId || metadata.goodreadsId,
      cover: result.cover || null,
    };
  }

  if (result && result.notFound) {
    metadata.goodreadsCheck = "Not Found";
  } else {
    metadata.goodreadsCheck = "Error";
  }

  return metadata;
}

module.exports = { parseFilename, getBasicBookInfo, enrichBookMetadata };
