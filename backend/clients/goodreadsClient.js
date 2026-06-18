const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { extractGenres } = require("./tagExtractor");
puppeteer.use(StealthPlugin());

const SIMILARITY_THRESHOLD = 0.6;
const AUTHOR_MATCH_THRESHOLD = 0.5;

/**
 * Cleans a search query string.
 */
function cleanSearchQuery(query) {
  if (!query) return "";
  return query
    .replace(/[đĐ]/g, (char) => (char === "đ" ? "d" : "D"))
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^\d+[\s.-]+/, "")
    .replace(/[._]/g, " ")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Strips noise from a book title candidate.
 */
function stripTitleNoise(title) {
  return title
    .replace(/\([^)]{0,500}\)/g, "")
    .replace(/\[[^\]]{0,500}\]/g, "")
    .split("-")[0]
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculates similarity between two titles using F1 score.
 */
function calculateTitleSimilarity(queryTitle, candidateTitle) {
  if (!queryTitle || !candidateTitle) return 0;

  const queryWords = cleanSearchQuery(queryTitle).split(/\s+/).filter(Boolean);
  const candidateWords = cleanSearchQuery(stripTitleNoise(candidateTitle))
    .split(/\s+/)
    .filter(Boolean);

  if (!queryWords.length || !candidateWords.length) return 0;

  const candidateSet = new Set(candidateWords);
  const querySet = new Set(queryWords);

  const recall = queryWords.filter((word) => candidateSet.has(word)).length / queryWords.length;
  const precision = candidateWords.filter((word) => querySet.has(word)).length / candidateWords.length;

  if (recall + precision === 0) return 0;
  return (2 * recall * precision) / (recall + precision);
}

/**
 * Checks if expected authors (string or array) match candidate author string from Goodreads.
 * expectedAuthors: string[] từ filename parser, VD: ["Carlo Rovelli", "Nguyễn Hải Châu"]
 * candidateAuthor: string từ Goodreads, VD: "Carlo Rovelli, Tạ Phương"
 *
 * Match khi ÍT NHẤT 1 expected author khớp với ít nhất 1 candidate name.
 */
function isAuthorMatch(expectedAuthors, candidateAuthor) {
  if (!expectedAuthors || !candidateAuthor) return true;

  // Chuẩn hoá expectedAuthors thành array
  const expectedList = Array.isArray(expectedAuthors)
    ? expectedAuthors.filter(Boolean)
    : [expectedAuthors];

  if (!expectedList.length) return true;

  // Tách candidate thành từng tên, bỏ ghi chú như "(translator)"
  const candidateNames = candidateAuthor
    .split(",")
    .map((name) => name.replace(/\([^)]{0,500}\)/g, "").trim())
    .filter(Boolean);

  if (!candidateNames.length) return true;

  // Với mỗi expected author, kiểm tra xem có match với bất kỳ candidate name nào không
  return expectedList.some((expected) => {
    const expectedWords = cleanSearchQuery(expected).split(/\s+/).filter(Boolean);
    if (!expectedWords.length) return false;
    const expectedSet = new Set(expectedWords);

    return candidateNames.some((candidate) => {
      const candidateWords = cleanSearchQuery(candidate).split(/\s+/).filter(Boolean);
      if (!candidateWords.length) return false;
      const candidateSet = new Set(candidateWords);

      // Chiều 1: candidate words có trong expected? (candidate ⊆ expected)
      // VD: "Carlo Rovelli" vs expected "Carlo Rovelli" → 2/2 = 1.0 ✓
      const fwdMatch = candidateWords.filter((w) => expectedSet.has(w)).length / candidateWords.length;
      if (fwdMatch > AUTHOR_MATCH_THRESHOLD) return true;

      // Chiều 2: expected words có trong candidate? (expected ⊆ candidate)
      const bwdMatch = expectedWords.filter((w) => candidateSet.has(w)).length / expectedWords.length;
      return bwdMatch > AUTHOR_MATCH_THRESHOLD;
    });
  });
}

/**
 * Evaluates search results on the page to find a matching book.
 */
async function evaluateSearchResults(page, { expectedTitle, expectedAuthors, threshold }) {
  const candidates = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a.bookTitle, a[href*="/book/show/"]'));
    return links.slice(0, 5).map((link) => {
      const row = link.closest('tr, .bookRow, [itemtype*="Book"]') || link.parentElement;
      // Lấy tất cả authorName (gồm cả dịch giả), join bằng dấu phẩy
      const authorEls = row?.querySelectorAll('.authorName, [data-testid="author"]');
      const author = authorEls && authorEls.length > 0
        ? Array.from(authorEls).map((el) => el.innerText?.trim()).filter(Boolean).join(", ")
        : row?.querySelector('.by a')?.innerText?.trim() || "";
      return {
        href: link.href,
        title: link.innerText?.trim() || link.title || "",
        author,
      };
    });
  });

  for (const candidate of candidates) {
    const titleScore = calculateTitleSimilarity(expectedTitle, candidate.title);
    const authorMatches = isAuthorMatch(expectedAuthors, candidate.author);

    if (titleScore >= threshold && authorMatches) {
      return candidate.href;
    }
  }
  return null;
}

/**
 * Finds a book URL by searching Goodreads.
 */
async function findBookUrl(page, searchUrl, options) {
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  if (page.url().includes("/book/show/")) {
    return page.url();
  }

  try {
    await page.waitForSelector("a.bookTitle", { timeout: 10000 });
  } catch {
    if (page.url().includes("/book/show/")) return page.url();
    return null;
  }

  return await evaluateSearchResults(page, options);
}

/**
 * Extracts metadata from a book page.
 */
async function extractBookMetadata(page) {
  const basicMetadata = await page.evaluate(() => {
    const getElementText = (selector) => document.querySelector(selector)?.innerText?.trim() || "";

    const title = getElementText('h1[data-testid="bookTitle"]') || getElementText("#bookTitle");
    const author = getElementText(".ContributorLink__name") || getElementText(".authorName") || getElementText('[data-testid="name"]');
    const ratingText = getElementText(".RatingStatistics__rating") || getElementText('[itemprop="ratingValue"]');
    const ratingCountRaw = getElementText('[data-testid="ratingsCount"]') || getElementText(".minirating") || getElementText('.RatingStatistics__meta > [data-testid="ratingsCount"]') || getElementText("#bookMeta .greyText.uitext");

    const rating = isNaN(parseFloat(ratingText)) ? "N/A" : parseFloat(ratingText).toFixed(2);
    let ratingCount = "";
    if (ratingCountRaw) {
      const parts = ratingCountRaw.trim().split(/\s+/);
      ratingCount = (parts[0] || "").replace(/[^\d]/g, "");
    }

    const cover = document.querySelector(".BookCover__image img")?.src || document.querySelector("#coverImage")?.src || "";
    const pubInfo = getElementText('.FeaturedDetails p[data-testid="publicationInfo"]') || getElementText("#details .row:last-child") || "";
    const year = pubInfo.match(/(\d{4})/)?.[1] ?? "N/A";

    return {
      title,
      author,
      rating,
      ratingCount,
      cover,
      year,
      url: window.location.href,
      goodreadsId: window.location.href.match(/\/show\/(\d+)/)?.[1] ?? "",
    };
  });

  // Genres cần page.click() (nút "...more") nên xử lý riêng, không nhúng vào page.evaluate()
  let genres = [];
  try {
    genres = await extractGenres(page);
  } catch (error) {
    console.error(`[GoodreadsClient] Genre extraction error: ${error.message}`);
  }

  return { ...basicMetadata, genres };
}

/**
 * Attempts to find a book URL using different search strategies.
 */
async function searchForBookUrl(page, { title, authors }) {
  // Dùng tác giả đầu tiên (tác giả gốc) để search, bỏ dịch giả
  const primaryAuthor = Array.isArray(authors) ? (authors[0] || "") : (authors || "");
  const options = { expectedTitle: title, expectedAuthors: authors, threshold: SIMILARITY_THRESHOLD };

  // Strategy 1: Title + Primary Author
  const fullQuery = encodeURIComponent(`${cleanSearchQuery(title)} ${cleanSearchQuery(primaryAuthor)}`);
  let url = await findBookUrl(page, `https://www.goodreads.com/search?q=${fullQuery}`, options);
  if (url) return url;

  // Strategy 2: Title Only
  const titleQuery = encodeURIComponent(cleanSearchQuery(title));
  return await findBookUrl(page, `https://www.goodreads.com/search?q=${titleQuery}`, options);
}

/**
 * Main function to fetch book metadata from Goodreads.
 * @param {string} title
 * @param {string | string[]} authors - Có thể là string (legacy) hoặc string[] (mới)
 * @param {string} goodreadsId
 */
const PUPPETEER_USER_DATA_DIR = process.env.PUPPETEER_USER_DATA_DIR;

let queue = Promise.resolve();

async function _fetchMetadata(title, authors = [], goodreadsId = "") {
  // Tương thích ngược: nếu truyền vào string thì wrap thành array
  let authorsArray = [];
  if (Array.isArray(authors)) {
    authorsArray = authors.filter(Boolean);
  } else if (authors) {
    authorsArray = [authors];
  }

  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      userDataDir: PUPPETEER_USER_DATA_DIR,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    let bookUrl = goodreadsId
      ? `https://www.goodreads.com/book/show/${goodreadsId}`
      : await searchForBookUrl(page, { title, authors: authorsArray });

    if (!bookUrl) {
      return { notFound: true, searchedTitle: title, searchedAuthors: authorsArray };
    }

    if (page.url() !== bookUrl) {
      await page.goto(bookUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    }

    await page.waitForSelector('h1[data-testid="bookTitle"]', { timeout: 15000 }).catch(() => null);
    const metadata = await extractBookMetadata(page);

    return metadata;
  } catch (error) {
    console.error(`[GoodreadsClient] Error: ${error.message}`);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function fetchMetadata(title, authors = [], goodreadsId = "") {
  queue = queue.then(() => _fetchMetadata(title, authors, goodreadsId));
  return queue;
}

module.exports = { fetchMetadata, calculateTitleSimilarity, cleanSearchQuery };