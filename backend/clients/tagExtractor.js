const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "../config/tagConfig.json");

/**
 * Danh sách quốc gia / khu vực / demonym phổ biến, dùng để tự động phát
 * hiện tag chỉ xuất xứ (Indonesia, Scotland, Asia, Japanese Literature...).
 * Built-in trong code (không cần config tay) vì đây là danh sách tĩnh,
 * gần như không đổi — khác với genre/blacklist là thứ bạn sẽ tinh chỉnh dần.
 *
 * Cách dùng: nếu TOÀN BỘ các từ "lõi" còn lại của 1 tag (sau khi bỏ các từ
 * hậu tố như "literature", "fiction") đều khớp với 1 entry trong danh sách
 * này, tag đó được coi là location-tag → priority thấp nhất.
 */
const LOCATION_WORDS = new Set([
    "africa", "african", "america", "american", "asia", "asian", "europe", "european",
    "oceania", "middle east", "latin america", "latin american",
    "vietnam", "vietnamese", "japan", "japanese", "china", "chinese", "korea", "korean",
    "india", "indian", "indonesia", "indonesian", "thailand", "thai", "philippines", "filipino",
    "malaysia", "malaysian", "singapore", "singaporean",
    "france", "french", "germany", "german", "italy", "italian", "spain", "spanish",
    "england", "english", "britain", "british", "scotland", "scottish", "ireland", "irish",
    "wales", "welsh", "russia", "russian", "poland", "polish", "netherlands", "dutch",
    "sweden", "swedish", "norway", "norwegian", "denmark", "danish", "finland", "finnish",
    "greece", "greek", "portugal", "portuguese", "turkey", "turkish",
    "egypt", "egyptian", "nigeria", "nigerian", "kenya", "kenyan", "morocco", "moroccan",
    "south africa", "south african",
    "mexico", "mexican", "brazil", "brazilian", "argentina", "argentinian",
    "canada", "canadian", "australia", "australian", "new zealand",
    "israel", "israeli", "palestine", "palestinian", "iran", "iranian", "iraq", "iraqi",
    "saudi arabia", "saudi", "afghanistan", "afghan", "pakistan", "pakistani",
    "bangladesh", "bangladeshi", "nepal", "nepali", "sri lanka",
    "cuba", "cuban", "colombia", "colombian", "chile", "chilean", "peru", "peruvian",
    "scandinavia", "scandinavian", "balkan", "caribbean", "nordic"
]);

/**
 * Từ hậu tố thường đi kèm location-tag, cần bỏ trước khi so khớp với
 * LOCATION_WORDS. VD: "Japanese Literature" -> bỏ "literature" -> "japanese".
 */
const LOCATION_SUFFIX_WORDS = new Set(["literature", "fiction", "history", "culture", "writers", "authors"]);

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
 * Kiểm tra xem 1 tag (đã normalize) có phải là location-tag không.
 * VD: "japanese literature" -> bỏ "literature" -> "japanese" -> match LOCATION_WORDS -> true.
 *     "scotland" -> match trực tiếp -> true.
 *     "asia" -> match trực tiếp -> true.
 *     "fantasy" -> không match -> false.
 */
function isLocationTag(normalizedTag) {
    if (LOCATION_WORDS.has(normalizedTag)) return true;

    const words = normalizedTag.split(" ").filter((w) => !LOCATION_SUFFIX_WORDS.has(w));
    const coreTag = words.join(" ").trim();
    if (!coreTag) return false;

    return LOCATION_WORDS.has(coreTag);
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
 * 1 = bình thường, 2 = generic, 3 = location (thấp nhất, chỉ lấp đầy
 * khi không đủ 6 tag khác).
 */
function getTagPriority(canonicalTag, config) {
    const normalized = normalizeKey(canonicalTag);

    if (isLocationTag(normalized)) return 3;

    const priorityGenreSet = new Set(config.priorityGenres.map(normalizeKey));
    if (priorityGenreSet.has(normalized)) return 0;

    const genericSet = new Set(config.genericTags.map(normalizeKey));
    if (genericSet.has(normalized)) return 2;

    const lowPrioritySet = new Set(config.lowPriorityTags.map(normalizeKey));
    if (lowPrioritySet.has(normalized)) return 3;

    return 1;
}

/**
 * Loại bỏ các tag "cụ thể" khi tag "tổng quát" hơn của nó đã có mặt.
 * VD: "Fantasy" + "Young Adult Fantasy" -> chỉ giữ "Fantasy".
 *     "Science Fiction" + "Science Fiction Fantasy" -> chỉ giữ "Science Fiction"
 *     (lưu ý: nếu CHỈ có "Young Adult Fantasy" mà KHÔNG có "Fantasy" riêng,
 *     vẫn giữ nguyên "Young Adult Fantasy" — không tự suy ra parent không tồn tại).
 *
 * Thuật toán: với mỗi cặp tag (A, B) còn lại, nếu set từ của A là tập con
 * thực sự của set từ B (A ngắn hơn, B chứa hết từ của A + thêm từ khác),
 * thì B bị coi là "cụ thể hơn A" -> loại B, giữ A.
 *
 * @param {Map<string, object>} tagMap canonicalName -> info, sẽ bị mutate (xoá entry bị loại).
 */
function suppressCompoundGenres(tagMap) {
    const names = Array.from(tagMap.keys());
    const wordSetOf = (name) => new Set(normalizeKey(name).split(" ").filter(Boolean));

    const toRemove = new Set();

    for (const general of names) {
        if (toRemove.has(general)) continue;
        const generalWords = wordSetOf(general);

        for (const specific of names) {
            if (specific === general || toRemove.has(specific)) continue;
            const specificWords = wordSetOf(specific);

            // specific phải dài hơn general, và chứa TOÀN BỘ từ của general
            if (specificWords.size <= generalWords.size) continue;

            const containsAll = [...generalWords].every((w) => specificWords.has(w));
            if (containsAll) {
                toRemove.add(specific);
            }
        }
    }

    toRemove.forEach((name) => tagMap.delete(name));
}

/**
 * Lọc + gộp đồng nghĩa + loại compound-genre dư + rank + cắt về tối đa maxTags.
 *
 * @param {string[]} rawTags Danh sách tag thô lấy từ Goodreads, theo đúng thứ tự xuất hiện.
 * @param {object} config Config đã load (hoặc để trống để tự load).
 * @returns {string[]} Danh sách tag đã xử lý, tối đa maxTags item.
 */
function processTags(rawTags, config = null) {
    const cfg = config || loadConfig();
    const blacklistSet = new Set(cfg.blacklist.map(normalizeKey));
    const synonymLookup = buildSynonymLookup(cfg.synonymMap);

    const seen = new Map(); // canonicalName -> { priority, originalIndex }

    rawTags.forEach((rawTag, index) => {
        if (!rawTag || !rawTag.trim()) return;

        const normalizedRaw = normalizeKey(rawTag);
        if (blacklistSet.has(normalizedRaw)) return;

        const canonical = resolveCanonicalName(rawTag, synonymLookup);

        if (!seen.has(canonical)) {
            seen.set(canonical, {
                priority: getTagPriority(canonical, cfg),
                originalIndex: index,
            });
        }
    });

    // Loại "Young Adult Fantasy" nếu đã có "Fantasy", v.v. — chỉ áp dụng
    // trong nhóm tag KHÔNG phải location (để không bị ảnh hưởng bởi việc
    // "Japanese Literature" chứa từ "literature" trùng "Literature" chung).
    // Đơn giản hoá: bỏ qua location-tag khi xét containment, vì chúng đã
    // bị priority 3 (xếp cuối) và không nên bị dùng làm "specific" của genre.
    const nonLocationEntries = new Map(
        Array.from(seen.entries()).filter(([, info]) => info.priority !== 3)
    );
    suppressCompoundGenres(nonLocationEntries);

    // Ghép lại: giữ tag location nguyên vẹn (đã priority 3), cộng với
    // tag non-location đã được lọc compound.
    const finalMap = new Map();
    seen.forEach((info, name) => {
        if (info.priority === 3 || nonLocationEntries.has(name)) {
            finalMap.set(name, info);
        }
    });

    const sorted = Array.from(finalMap.entries()).sort((a, b) => {
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
    isLocationTag,
    processTags,
    scrapeRawGenres,
    extractGenres,
};