const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

/**
 * Cleans a string by removing accents, special characters, and numbering.
 * Properly handles Vietnamese 'đ'.
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
 * Strips noise from a Goodreads candidate title before scoring:
 *   1. Parenthetical/bracket series info   "Title (Series Name, #4)"  → "Title"
 *   2. Dash-separated subtitles            "Title - Subtitle"          → "Title"
 *
 * We only want the bare main title so that extra words in subtitles or
 * series names can't accidentally inflate or deflate the similarity score.
 *
 * NOTE: this is applied to the CANDIDATE (Goodreads result) only — the
 * query title coming from the filename is left intact so its words are
 * still fully checked.
 */
function stripCandidateNoise(title) {
  return title
    // eslint-disable-next-line sonarjs/slow-regex
    .replace(/\s*[[()].*$/, "") // remove (Series...) / [Edition...]
    // eslint-disable-next-line sonarjs/slow-regex
    .replace(/\s*-.*$/, "") // remove - Subtitle
    .trim();
}

/**
 * Computes a word-overlap similarity score (0.0 – 1.0).
 *
 * Scoring is done against the CORE title only (series info stripped),
 * and uses a bidirectional check: both
 *   - how many query words appear in the candidate (recall), and
 *   - how many candidate words appear in the query (precision)
 * then returns the harmonic mean (F1), so a 3-word query can't
 * falsely match a 20-word candidate just because 2 words overlap.
 */
function titleSimilarity(queryTitle, candidateTitle) {
  if (!queryTitle || !candidateTitle) return 0;

  const normalizeQuery = (s) =>
    cleanSearchQuery(s).split(/\s+/).filter(Boolean);
  const normalizeCandidate = (s) =>
    cleanSearchQuery(stripCandidateNoise(s)).split(/\s+/).filter(Boolean);

  const queryWords = normalizeQuery(queryTitle);
  const candidateWords = normalizeCandidate(candidateTitle);

  if (queryWords.length === 0 || candidateWords.length === 0) return 0;

  const candidateSet = new Set(candidateWords);
  const querySet = new Set(queryWords);

  const recall =
    queryWords.filter((w) => candidateSet.has(w)).length / queryWords.length;
  const precision =
    candidateWords.filter((w) => querySet.has(w)).length /
    candidateWords.length;

  if (recall + precision === 0) return 0;
  return (2 * recall * precision) / (recall + precision); // F1
}

const SIMILARITY_THRESHOLD = 0.4; // normal threshold for attempts 1 & 2
const HALF_TITLE_THRESHOLD = 0.65; // stricter threshold for the weaker half-title fallback

/**
 * Searches Goodreads with a given URL and returns the first result URL
 * whose title passes the similarity check against `expectedTitle`.
 * Returns null if nothing passes.
 */
async function findBookUrlInResults(
  page,
  searchUrl,
  expectedTitle,
  threshold = SIMILARITY_THRESHOLD,
) {
  console.log(`[Scraper] Searching: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const BOOK_TITLE_SELECTOR = "a.bookTitle";
  try {
    await page.waitForSelector(BOOK_TITLE_SELECTOR, { timeout: 10000 });
  } catch {
    // results might still be in the DOM even without the selector
  }

  // Collect up to 5 candidate results so we can pick the best match
  const candidates = await page.evaluate((selector) => {
    const links = Array.from(
      document.querySelectorAll(selector + ', a[href*="/book/show/"]'),
    );
    return links.slice(0, 5).map((a) => ({
      href: a.href,
      text: a.innerText?.trim() || a.title || "",
    }));
  }, BOOK_TITLE_SELECTOR);

  console.log(
    `[Scraper] Found ${candidates.length} candidate(s) for "${expectedTitle}" (threshold: ${(threshold * 100).toFixed(0)}%)`,
  );

  for (const c of candidates) {
    const score = titleSimilarity(expectedTitle, c.text);
    console.log(
      `[Scraper]   Candidate: "${c.text}" → F1 similarity ${(score * 100).toFixed(0)}%`,
    );
    if (score >= threshold) {
      console.log(`[Scraper]   ✓ Accepted`);
      return c.href;
    }
  }

  console.log(`[Scraper]   ✗ No candidate passed the similarity threshold`);
  return null;
}

/**
 * Scrapes book metadata from Goodreads.
 *
 * Accepts either:
 *   - separate `title` + `author` strings (preferred), or
 *   - a combined `searchQuery` string (legacy), or
 *   - a direct `goodreadsId`.
 *
 * Returns null (with a `notFound: true` flag) instead of a wrong book.
 */
async function scrapeGoodreads(
  titleOrQuery,
  authorOrId = "",
  goodreadsId = ""
) {
  const title = titleOrQuery || "";
  const gId = !goodreadsId && /^\d+$/.test(authorOrId) ? authorOrId : goodreadsId;
  const author = gId === authorOrId ? "" : authorOrId;

  console.log(
    `[Scraper] Launching browser — title: "${title}" | author: "${author}" | id: "${gId}"`
  );

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );

    let bookUrl = "";

    // ── Direct ID lookup (no validation needed) ──────────────────────────
    if (gId) {
      bookUrl = `https://www.goodreads.com/book/show/${gId}`;
      console.log(`[Scraper] Going directly to Goodreads ID: ${gId}`);
      await page.goto(bookUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      // ── Search path ───────────────────────────────────────────────────────
    } else {
      const cleanTitle = cleanSearchQuery(title);
      const cleanAuthor = cleanSearchQuery(author);

      // Attempt 1 — title + author (most precise)
      if (cleanTitle && cleanAuthor) {
        const q = encodeURIComponent(`${cleanTitle} ${cleanAuthor}`);
        bookUrl = await findBookUrlInResults(
          page,
          `https://www.goodreads.com/search?q=${q}`,
          title,
        );
      }

      // Attempt 2 — title only
      if (!bookUrl && cleanTitle) {
        const q = encodeURIComponent(cleanTitle);
        bookUrl = await findBookUrlInResults(
          page,
          `https://www.goodreads.com/search?q=${q}`,
          title,
        );
      }

      // Attempt 3 — first half of the title (catches long subtitle situations)
      if (!bookUrl && cleanTitle) {
        const words = cleanTitle.split(" ");
        const halfTitle = words
          .slice(0, Math.max(2, Math.ceil(words.length / 2)))
          .join(" ");
        if (halfTitle !== cleanTitle) {
          const q = encodeURIComponent(halfTitle);
          bookUrl = await findBookUrlInResults(
            page,
            `https://www.goodreads.com/search?q=${q}`,
            title,
            HALF_TITLE_THRESHOLD,
          );
        }
      }

      if (!bookUrl) {
        console.log(
          `[Scraper] ✗ All search attempts failed — refusing to return a wrong book.`,
        );
        await browser.close();
        return { notFound: true, searchedTitle: title, searchedAuthor: author };
      }
    }

    // ── Navigate to book page ─────────────────────────────────────────────
    console.log(`[Scraper] Navigating to book page: ${bookUrl}`);
    if (page.url() !== bookUrl) {
      await page.goto(bookUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    await page
      .waitForSelector('h1[data-testid="bookTitle"]', { timeout: 15000 })
      .catch(() => null);

    const data = await page.evaluate(() => {
      const getTxt = (sel) =>
        document.querySelector(sel)?.innerText?.trim() || "";

      const title =
        getTxt('h1[data-testid="bookTitle"]') || getTxt("#bookTitle");
      const author =
        getTxt(".ContributorLink__name") ||
        getTxt(".authorName") ||
        getTxt('[data-testid="name"]');

      const ratingTxt =
        getTxt(".RatingStatistics__rating") ||
        getTxt('[itemprop="ratingValue"]');
      const ratingCount =
        getTxt('[data-testid="ratingsCount"]') ||
        getTxt(".minirating") ||
        getTxt('.RatingStatistics__meta > [data-testid="ratingsCount"]') ||
        getTxt("#bookMeta .greyText.uitext");

      let finalRating = isNaN(parseFloat(ratingTxt))
        ? "N/A"
        : parseFloat(ratingTxt).toFixed(2);
      let finalRatingCount = "";
      if (ratingCount) {
        // eslint-disable-next-line sonarjs/slow-regex
        const match = /([\d,]+)\s+ratings?/.exec(ratingCount);
        if (match) {
          finalRatingCount = match[1].replace(/,/g, "");
        } else if (ratingCount.includes("ratings")) {
          finalRatingCount = ratingCount.replace(/[^\d]/g, "");
        }
      }

      const cover =
        document.querySelector(".BookCover__image img")?.src ||
        document.querySelector("#coverImage")?.src ||
        "";
      const pubInfo =
        getTxt('.FeaturedDetails p[data-testid="publicationInfo"]') ||
        getTxt("#details .row:last-child") ||
        "";
      const year = pubInfo.match(/(\d{4})/)?.[1] ?? "N/A";

      const url = window.location.href;
      const extractedId = url.match(/\/show\/(\d+)/)?.[1] ?? "";

      return {
        title,
        author,
        rating: finalRating,
        ratingCount: finalRatingCount,
        cover,
        year,
        url,
        goodreadsId: extractedId,
      };
    });

    await browser.close();
    return data;
  } catch (err) {
    console.error(`[Scraper Error] ${err.message}`);
    await browser.close();
    return null;
  }
}

module.exports = { scrapeGoodreads, titleSimilarity, cleanSearchQuery };
