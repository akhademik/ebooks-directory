/**
 * String utilities for similarity comparison and text cleaning.
 */

/**
 * Removes Vietnamese accents and diacritics.
 * @param {string} str The string to normalize.
 * @returns {string} The normalized string.
 */
function removeAccents(str) {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
    .toLowerCase();
}

/**
 * Cleans text by removing special characters and extra spaces.
 * @param {string} text The text to clean.
 * @returns {string} The cleaned text.
 */
function cleanText(text) {
  const normalized = removeAccents(text);
  return normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generates bigrams for a string.
 * @param {string} str The input string.
 * @returns {Set<string>} A set of bigrams.
 */
function getBigrams(str) {
  const bigrams = new Set();
  if (!str || str.length < 2) return bigrams;
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * Calculates string similarity using Dice Coefficient.
 * @param {Set<string>} set1 Bigrams of the first string.
 * @param {Set<string>} set2 Bigrams of the second string.
 * @returns {number} Similarity score between 0 and 1.
 */
function getStringSimilarity(set1, set2) {
  if (!set1 || !set2 || set1.size === 0 || set2.size === 0) return 0;

  let intersection = 0;
  for (const gram of set1) {
    if (set2.has(gram)) intersection++;
  }

  return (2.0 * intersection) / (set1.size + set2.size);
}

/**
 * Extracts only the title part from a full filename/title string.
 * Splits on " - " and takes the first part to avoid author name
 * polluting the title similarity comparison.
 * e.g. "Cảnh Ngộ - Minato Kanae _ Mai Khanh (dịch)_10922" → "Cảnh Ngộ"
 * e.g. "Clean Code - Robert Martin" → "Clean Code"
 */
function extractTitle(str) {
  if (!str) return "";
  // Split on " - " with optional whitespace, more robust but safe
  const parts = str.split(" - ");
  return parts[0].trim();
}

module.exports = {
  removeAccents,
  cleanText,
  getBigrams,
  getStringSimilarity,
  extractTitle,
};
