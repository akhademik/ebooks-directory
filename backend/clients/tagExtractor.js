const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "../config/genreConfig.json");

/**
 * Load config từ file JSON. Đọc lại mỗi lần gọi để bạn sửa config
 * mà không cần restart process.
 */
function loadConfig() {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
}

/**
 * Chuẩn hoá string để so khớp: lowercase, bỏ dấu, bỏ ký tự đặc biệt,
 * gộp khoảng trắng và gạch ngang.
 */
function normalizeKey(str) {
    return str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[-_]/g, " ")
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Build lookup map đã normalize key, từ config.tagToGenreMap.
 * Trả về Map<normalizedRawTag, fixedGenreName>.
 */
function buildGenreLookup(tagToGenreMap) {
    const lookup = new Map();
    for (const [rawTag, genre] of Object.entries(tagToGenreMap)) {
        lookup.set(normalizeKey(rawTag), genre);
    }
    return lookup;
}

/**
 * Map 1 tag thô Goodreads về 1 trong các fixedGenres, hoặc null nếu
 * không tìm thấy trong bảng map (tag bị bỏ qua, không hiện trong dropdown).
 */
function mapTagToFixedGenre(rawTag, genreLookup) {
    const key = normalizeKey(rawTag);
    return genreLookup.get(key) || null;
}

/**
 * Map toàn bộ tag thô về danh sách các fixedGenres (đã loại trùng,
 * giữ đúng thứ tự xuất hiện gốc của Goodreads — genre xuất hiện sớm
 * hơn trong danh sách gốc được coi là liên quan hơn), cắt về maxTags.
 *
 * @param {string[]} rawTags Tag thô lấy từ Goodreads, theo thứ tự xuất hiện.
 * @param {object} config Config đã load (hoặc để trống để tự load).
 * @returns {string[]} Danh sách genre đã chuẩn hoá, mỗi item nằm trong config.fixedGenres, tối đa maxTags item.
 */
function processTags(rawTags, config = null) {
    const cfg = config || loadConfig();
    const genreLookup = buildGenreLookup(cfg.tagToGenreMap);

    const seen = new Map(); // fixedGenre -> originalIndex (nhỏ nhất = xuất hiện sớm nhất)

    rawTags.forEach((rawTag, index) => {
        if (!rawTag || !rawTag.trim()) return;

        const genre = mapTagToFixedGenre(rawTag, genreLookup);
        if (!genre) return; // tag không map được -> bỏ qua, không vào dropdown

        if (!seen.has(genre)) {
            seen.set(genre, index);
        }
    });

    const sorted = Array.from(seen.entries()).sort((a, b) => a[1] - b[1]);

    return sorted.slice(0, cfg.maxTags).map(([genre]) => genre);
}

/**
 * Scrape genres thô trực tiếp từ trang Goodreads (page đã navigate tới book page).
 * Tự động bấm "...more" nếu có để lấy thêm genres mở rộng trong cùng DOM,
 * KHÔNG bấm "Show All" (link sang /work/shelves/... chứa shelf rác do user tự gắn).
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string[]>} Danh sách tag thô, theo thứ tự xuất hiện trên trang.
 */
async function scrapeRawGenres(page) {
    try {
        const moreButton = await page.$('ul[aria-label="Top genres for this book"] button[aria-label="Show all items in the list"]');
        if (moreButton) {
            await moreButton.click();
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    } catch {
        // Không có nút more, hoặc đã ở dạng expanded — bỏ qua, tiếp tục scrape.
    }

    const rawTags = await page.evaluate(() => {
        const container = document.querySelector('ul[aria-label="Top genres for this book"]');
        if (!container) return [];

        const links = Array.from(container.querySelectorAll('a[href*="/genres/"]'));
        return links
            .map((a) => a.querySelector(".Button__labelItem")?.innerText?.trim() || a.innerText?.trim() || "")
            .filter(Boolean);
    });

    return rawTags;
}

/**
 * Hàm tổng hợp: scrape + map về 28 genre cố định, dùng trực tiếp trong goodreadsClient.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string[]>} Tối đa maxTags genre, mỗi genre nằm trong fixedGenres.
 */
async function extractGenres(page) {
    const rawTags = await scrapeRawGenres(page);
    if (!rawTags.length) return [];
    return processTags(rawTags);
}

module.exports = {
    loadConfig,
    normalizeKey,
    mapTagToFixedGenre,
    processTags,
    scrapeRawGenres,
    extractGenres,
};