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
 * Strips noise from a Goodreads candidate title before scoring.
 *
 * Order matters:
 *   1. Strip ALL parenthetical/bracket blocks anywhere in the string
 *      "Title (Series, #4) - Subtitle" → "Title  - Subtitle"
 *      This handles series info that appears mid-title or at the end.
 *   2. Strip everything after the first dash (subtitle)
 *      "Title  - Subtitle" → "Title"
 *   3. Collapse extra spaces
 *
 * Applied to the CANDIDATE only — query title from filename is left intact.
 */
function stripCandidateNoise(title) {
  return title
    .replace(/\s*[\[(][^\]\)]*[\]\)]/g, "") // remove ALL (...) and [...] blocks
    .replace(/\s*-.*$/, "") // remove - Subtitle
    .replace(/\s+/g, " ")
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

const SIMILARITY_THRESHOLD = 0.6; // title F1 threshold for attempts 1 & 2
const HALF_TITLE_THRESHOLD = 0.75; // stricter threshold for the weaker half-title fallback
const AUTHOR_MATCH_THRESHOLD = 0.5; // fraction of filename-author words that must appear in one Goodreads name

/**
 * Author check: returns true if the filename author fuzzy-matches ANY ONE
 * of the names listed in the Goodreads author string.
 *
 * Goodreads lists contributors as "Name A, Name B (Translator), Name C".
 * For Vietnamese books the filename author may be the translator, so we
 * check every comma-separated name individually.
 *
 * A name is considered a match when the majority (>50%) of the filename
 * author's words appear in that Goodreads name. This handles:
 *   - "Nguyen Hoang Nam" vs "Nguyen Hoang Nam, David James, Kyle Cook" → match on first name
 *   - "Phung Kim Lan" vs "Phung Kim Lan (Translator)" → match (parens stripped)
 *   - "Tran Thi B" vs "completely different, names here" → no match
 *
 * Returns true (pass) when no expected author is provided.
 */
function authorMatches(expectedAuthor, candidateAuthor) {
  if (!expectedAuthor || !candidateAuthor) return true;
  const normalize = (s) => cleanSearchQuery(s).split(/\s+/).filter(Boolean);
  const expectedWords = normalize(expectedAuthor);
  if (expectedWords.length === 0) return true;

  // Split Goodreads string into individual contributor names, strip role labels
  // e.g. "Nguyen Hoang Nam, David James (Translator)" → ["Nguyen Hoang Nam", "David James"]
  const candidateNames = candidateAuthor
    .split(",")
    .map((n) => n.replace(/\([^)]*\)/g, "").trim()) // strip (Translator) etc.
    .filter(Boolean);

  return candidateNames.some((name) => {
    const nameWords = new Set(normalize(name));
    if (nameWords.size === 0) return false;
    const matched = expectedWords.filter((w) => nameWords.has(w)).length;
    // Require majority of filename-author words to appear in this one name
    return matched / expectedWords.length > AUTHOR_MATCH_THRESHOLD;
  });
}

/**
 * Searches Goodreads with a given URL and returns the first result URL
 * whose title passes the F1 similarity check against `expectedTitle`,
 * AND whose author passes a loose check against `expectedAuthor` (when provided).
 * Returns null if nothing passes.
 */
async function findBookUrlInResults(
  page,
  searchUrl,
  expectedTitle,
  expectedAuthor = "",
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

  // Collect up to 5 candidates — grab both title link and nearby author element
  const candidates = await page.evaluate((selector) => {
    const links = Array.from(
      document.querySelectorAll(selector + ', a[href*="/book/show/"]'),
    );
    return links.slice(0, 5).map((a) => {
      const row =
        a.closest('tr, .bookRow, [itemtype*="Book"]') || a.parentElement;
      const authorEl = row?.querySelector(
        '.authorName, [data-testid="author"], .by a',
      );
      return {
        href: a.href,
        text: a.innerText?.trim() || a.title || "",
        author: authorEl?.innerText?.trim() || "",
      };
    });
  }, BOOK_TITLE_SELECTOR);

  console.log(
    `[Scraper] Found ${candidates.length} candidate(s) for "${expectedTitle}"` +
      (expectedAuthor ? ` by "${expectedAuthor}"` : "") +
      ` (title>=${(threshold * 100).toFixed(0)}%` +
      (expectedAuthor
        ? `, author word match >${(AUTHOR_MATCH_THRESHOLD * 100).toFixed(0)}%`
        : "") +
      `)`,
  );

  let bestRejected = null; // track best near-miss for tuning logs

  for (const c of candidates) {
    const titleScore = titleSimilarity(expectedTitle, c.text);
    const authorPassed = authorMatches(expectedAuthor, c.author);
    console.log(
      `[Scraper]   "${c.text}" by "${c.author}" → title ${(titleScore * 100).toFixed(0)}% | author ${authorPassed ? "✓" : "✗"}`,
    );

    const titleFails = titleScore < threshold;
    const authorFails = expectedAuthor && !authorPassed;

    if (!titleFails && !authorFails) {
      console.log(`[Scraper]   ✓ Accepted`);
      return c.href;
    }

    // Track best rejected candidate for the tuning log below
    if (!bestRejected || titleScore > bestRejected.titleScore) {
      bestRejected = {
        title: c.text,
        author: c.author,
        titleScore,
        authorPassed,
      };
    }

    if (titleFails)
      console.log(
        `[Scraper]     ✗ title too low (${(titleScore * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%)`,
      );
    if (authorFails)
      console.log(
        `[Scraper]     ✗ author mismatch — "${expectedAuthor}" not found in "${c.author}"`,
      );
  }

  if (bestRejected) {
    console.log(
      `[Scraper]   ✗ Best rejected: "${bestRejected.title}" by "${bestRejected.author}"` +
        ` — title ${(bestRejected.titleScore * 100).toFixed(0)}% | author ${bestRejected.authorPassed ? "✓" : "✗"}`,
    );
  }
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
  goodreadsId = "",
) {
  const title = titleOrQuery || "";
  const gId =
    !goodreadsId && /^\d+$/.test(authorOrId) ? authorOrId : goodreadsId;
  const author = gId === authorOrId ? "" : authorOrId;

  console.log(
    `[Scraper] Launching browser — title: "${title}" | author: "${author}" | id: "${gId}"`,
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

      // Attempt 1 — title + author search, validated against both title AND author
      if (cleanTitle && cleanAuthor) {
        const q = encodeURIComponent(`${cleanTitle} ${cleanAuthor}`);
        bookUrl = await findBookUrlInResults(
          page,
          `https://www.goodreads.com/search?q=${q}`,
          title,
          author, // ← author cross-check
          SIMILARITY_THRESHOLD,
        );
      }

      // Attempt 2 — title only search, still cross-check author if we have one
      if (!bookUrl && cleanTitle) {
        const q = encodeURIComponent(cleanTitle);
        bookUrl = await findBookUrlInResults(
          page,
          `https://www.goodreads.com/search?q=${q}`,
          title,
          author, // ← still validate author
          SIMILARITY_THRESHOLD,
        );
      }

      // Attempt 3 — first half of title, highest thresholds, still author-checked
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
            author, // ← still validate author
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
