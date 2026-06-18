const path = require("path");
const fs = require("fs");
const { fetchMetadata } = require("../clients/goodreadsClient");

const BYTES_PER_MB = 1024 * 1024;
const UNKNOWN_AUTHOR = "Unknown";

const FILENAME_SUFFIXES = [
  /_\d+$/,             // _10922
  /\(\d+\)$/,          // (1)
  /_copy$/i,           // _copy
  /\(scan\)$/i,        // (scan)
  /\[[^\]]{0,100}\]/g, // [EPUB]
  /\([^)]{0,100}\)/g,  // (2023)
];

/**
 * Strips common suffixes and "garbage" from a filename.
 * Giữ nguyên " _ " (space-underscore-space) để dùng làm delimiter tác giả/dịch giả.
 * Chỉ replace dot và underscore đơn lẻ (không có space hai bên) thành space.
 */
function stripSuffixes(name) {
  let cleaned = name;
  FILENAME_SUFFIXES.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, "");
  });

  // Strip leading numbers like "01. ", "1 - ", "123 "
  cleaned = cleaned.replace(/^\d+[\s.-]+/, "");

  // Replace dots with spaces
  cleaned = cleaned.replace(/\./g, " ");

  // Replace underscore KHÔNG có space hai bên → space (giữ " _ " nguyên)
  cleaned = cleaned.replace(/(?<! )_(?! )/g, " ");

  return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Extracts title and authors from a cleaned filename string.
 * Pattern: "Title - Author" hoặc "Title - Author _ Translator (dịch)"
 * Trả về authors array để goodreadsClient match chính xác từng người.
 */
function extractTitleAndAuthor(name) {
  let title = name;
  let authors = [];

  if (name.includes(" - ")) {
    const [titlePart, ...rest] = name.split(" - ");
    title = titlePart.trim();

    // "Carlo Rovelli _ Nguyễn Hải Châu (dịch)" → ["Carlo Rovelli", "Nguyễn Hải Châu"]
    const authorPart = rest.join(" - ").trim();
    authors = authorPart
      .split(" _ ")
      .map((p) => p.replace(/\([^)]{0,200}\)/g, "").trim())
      .filter(Boolean);
  }

  const author = authors.length > 0 ? authors[0] : UNKNOWN_AUTHOR;
  return { title, author, authors };
}

/**
 * Parses a filename to extract title and authors.
 */
function parseFilename(filename) {
  const extension = path.extname(filename);
  const baseName = path.basename(filename, extension);

  const cleanedName = stripSuffixes(baseName);
  const { title, author, authors } = extractTitleAndAuthor(cleanedName);

  return { title, author, authors, extension };
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
    authors: parsed.authors,
    year: "N/A",
    rating: "N/A",
    ratingCount: "",
    tags: [],
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

  // Truyền authors array thay vì string để goodreadsClient match chính xác
  let authorsArg = [];
  if (baseInfo.authors && baseInfo.authors.length > 0) {
    authorsArg = baseInfo.authors;
  } else if (baseInfo.author !== UNKNOWN_AUTHOR) {
    authorsArg = [baseInfo.author];
  }

  const result = await fetchMetadata(baseInfo.title, authorsArg, metadata.goodreadsId);

  if (result && !result.notFound) {
    return {
      ...metadata,
      title: result.title,
      author: result.author || baseInfo.author,
      tags: result.genres || [],
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