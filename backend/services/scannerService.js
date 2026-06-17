const path = require("path");
const fs = require("fs");
const { fetchMetadata } = require("../clients/goodreadsClient");

const BYTES_PER_MB = 1024 * 1024;
const UNKNOWN_AUTHOR = "Unknown";

const FILENAME_SUFFIXES = [
  /_\d+$/,           // _10922
  /\(\d+\)$/,        // (1)
  /_copy$/i,         // _copy
  /\(scan\)$/i,      // (scan)
  /\[[^\]]{0,100}\]/g, // [EPUB]
  /\([^)]{0,100}\)/g,  // (2023)
];

/**
 * Strips common suffixes and "garbage" from a filename.
 * @param {string} name Base filename without extension.
 * @returns {string} Cleaned name.
 */
function stripSuffixes(name) {
  let cleaned = name;
  FILENAME_SUFFIXES.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, "");
  });

  // Strip leading numbers like "01. ", "1 - ", "123 "
  cleaned = cleaned.replace(/^\d+[\s.-]+/, "");

  // Replace dots with spaces (keep underscores for " _ " delimiter)
  return cleaned.replace(/[.]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Cleans noise from an author/translator string:
 * - Strips fully closed translator annotations: (dịch), (trans.), (translator)
 * - Strips unclosed parentheses at end of string: (dịch, (dị, (dị, (d
 * - Normalizes " & " to ", " so multiple authors use consistent delimiter
 * @param {string} name Raw author or translator string.
 * @returns {string} Cleaned string.
 */
function cleanAuthorNoise(name) {
  return name
    // Strip closed translator annotations
    .replace(/\s{0,5}\((dịch|trans\.?|translator)\)\s{0,5}/gi, "")
    // Strip any unclosed "(" at end of string (truncated annotations)
    .replace(/\s{0,5}\([^)]{0,30}$/, "")
    // Normalize " & " to ", "
    .replace(/\s{0,5}&\s{0,5}/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts title and author (with translator folded in) from a cleaned filename string.
 * Patterns supported:
 *   "Title - Author"
 *   "Title - Author _ Translator"
 *   "Title - Author1 & Author2"
 * Result author field uses ", " as delimiter: "Author1, Author2" or "Author, Translator"
 * @param {string} name Cleaned filename string.
 * @returns {Object} { title, author }
 */
function extractTitleAndAuthor(name) {
  let title = name;
  let author = UNKNOWN_AUTHOR;

  if (name.includes(" - ")) {
    const [titlePart, ...rest] = name.split(" - ");
    title = titlePart.trim();

    let authorPart = rest.join(" - ").trim();
    if (authorPart.includes(" _ ")) {
      const [mainAuthor, ...translatorParts] = authorPart.split(" _ ");
      const cleanedMain = cleanAuthorNoise(mainAuthor);
      const cleanedTranslator = cleanAuthorNoise(translatorParts.join(" _ "));

      author = cleanedTranslator
        ? `${cleanedMain}, ${cleanedTranslator}`
        : cleanedMain;
    } else {
      author = cleanAuthorNoise(authorPart);
    }
  }

  return { title, author };
}

/**
 * Parses a filename to extract title and author.
 */
function parseFilename(filename) {
  const extension = path.extname(filename);
  const baseName = path.basename(filename, extension);

  const cleanedName = stripSuffixes(baseName);
  const { title, author } = extractTitleAndAuthor(cleanedName);

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

  // author field may be "Author, Translator" — only pass main author to search
  const mainAuthor = baseInfo.author !== UNKNOWN_AUTHOR
    ? baseInfo.author.split(",")[0].trim()
    : "";
  const result = await fetchMetadata(baseInfo.title, mainAuthor, metadata.goodreadsId);

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