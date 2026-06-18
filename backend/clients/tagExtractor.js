const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "../config/tagConfig.json");

/**
 * Load config từ file JSON. Đọc lại mỗi lần gọi để bạn sửa config
 * mà không cần restart process (đổi lại nếu cần performance cao hơn
 * có thể cache + watch file).
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
 * Build reverse-lookup map từ synonymMap: "sci fi" -> "Science Fiction", v.v.
 * Trả về Map<normalizedVariant, canonicalName>.
 */
function buildSynonymLookup(synonymMap) {
    const lookup = new Map();
    for (const [canonical, variants] of Object.entries(synonymMap)) {
        variants.forEach((variant) => {
            lookup.set(normalizeKey(variant), canonical);
        });
        // Canonical name cũng tự match với chính nó
        lookup.set(normalizeKey(canonical), canonical);
    }
    return lookup;
}

/**
 * Gộp 1 tag thô về tên canonical nếu có trong synonym map,
 * nếu không thì giữ nguyên tag gốc (đã trim).
 */
function resolveCanonicalName(rawTag, synonymLookup) {
    const key = normalizeKey(rawTag);
    return synonymLookup.get(key) || rawTag.trim();
}

/**
 * Phân loại priority của 1 tag: 0 = priority genre (cao nhất),
 * 1 = bình thường, 2 = generic, 3 = location/low-priority.
 * Số nhỏ hơn = ưu tiên cao hơn khi sort.
 */
function getTagPriority(canonicalTag, config) {
    const normalized = normalizeKey(canonicalTag);

    const priorityGenreSet = new Set(config.priorityGenres.map(normalizeKey));
    if (priorityGenreSet.has(normalized)) return 0;

    const genericSet = new Set(config.genericTags.map(normalizeKey));
    if (genericSet.has(normalized)) return 2;

    const lowPrioritySet = new Set(config.lowPriorityTags.map(normalizeKey));
    if (lowPrioritySet.has(normalized)) return 3;

    return 1;
}

/**
 * Lọc + gộp đồng nghĩa + rank + cắt về tối đa maxTags.
 *
 * @param {string[]} rawTags Danh sách tag thô lấy từ Goodreads, theo đúng thứ tự xuất hiện (đã là thứ tự ưu tiên của Goodreads).
 * @param {object} config Config đã load (hoặc để trống để tự load).
 * @returns {string[]} Danh sách tag đã xử lý, tối đa maxTags item.
 */
function processTags(rawTags, config = null) {
    const cfg = config || loadConfig();
    const blacklistSet = new Set(cfg.blacklist.map(normalizeKey));
    const synonymLookup = buildSynonymLookup(cfg.synonymMap);

    // Giữ lại thứ tự xuất hiện gốc (Goodreads đã sort theo độ liên quan)
    // để dùng làm tie-breaker khi 2 tag có cùng priority.
    const seen = new Map(); // canonicalName -> { priority, originalIndex }

    rawTags.forEach((rawTag, index) => {
        if (!rawTag || !rawTag.trim()) return;

        const normalizedRaw = normalizeKey(rawTag);
        if (blacklistSet.has(normalizedRaw)) return; // loại bỏ rác

        const canonical = resolveCanonicalName(rawTag, synonymLookup);

        // Nếu đã gặp canonical này rồi (do gộp đồng nghĩa), giữ originalIndex nhỏ nhất (xuất hiện sớm hơn = liên quan hơn)
        if (!seen.has(canonical)) {
            seen.set(canonical, {
                priority: getTagPriority(canonical, cfg),
                originalIndex: index,
            });
        }
    });

    const sorted = Array.from(seen.entries()).sort((a, b) => {
        const [, infoA] = a;
        const [, infoB] = b;
        if (infoA.priority !== infoB.priority) return infoA.priority - infoB.priority;
        return infoA.originalIndex - infoB.originalIndex;
    });

    return sorted.slice(0, cfg.maxTags).map(([name]) => name);
}

/**
 * Scrape genres trực tiếp từ trang Goodreads (page đã navigate tới book page).
 * Tự động bấm "...more" nếu có để lấy thêm genres mở rộng trong cùng DOM,
 * KHÔNG bấm "Show All" (link sang /work/shelves/... chứa shelf rác do user tự gắn).
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string[]>} Danh sách tag thô, theo thứ tự xuất hiện trên trang.
 */
async function scrapeRawGenres(page) {
    // Thử bấm "...more" nếu nút này tồn tại (mở rộng thêm genres trong cùng DOM)
    try {
        const moreButton = await page.$('ul[aria-label="Top genres for this book"] button[aria-label="Show all items in the list"]');
        if (moreButton) {
            await moreButton.click();
            await new Promise((resolve) => setTimeout(resolve, 300)); // chờ DOM update, không có network call
        }
    } catch {
        // Không có nút more, hoặc đã ở dạng expanded — bỏ qua, tiếp tục scrape.
    }

    const rawTags = await page.evaluate(() => {
        const container = document.querySelector('ul[aria-label="Top genres for this book"]');
        if (!container) return [];

        // Lấy tất cả link genre, NHƯNG loại trừ link "...show all" (dẫn tới /work/shelves/)
        const links = Array.from(container.querySelectorAll('a[href*="/genres/"]'));
        return links
            .map((a) => a.querySelector(".Button__labelItem")?.innerText?.trim() || a.innerText?.trim() || "")
            .filter(Boolean);
    });

    return rawTags;
}

/**
 * Hàm tổng hợp: scrape + xử lý, dùng trực tiếp trong goodreadsClient.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string[]>} Tối đa maxTags genre đã được lọc/chuẩn hoá.
 */
async function extractGenres(page) {
    const rawTags = await scrapeRawGenres(page);
    if (!rawTags.length) return [];
    return processTags(rawTags);
}

module.exports = {
    loadConfig,
    normalizeKey,
    processTags,
    scrapeRawGenres,
    extractGenres,
};