const { pdf } = require('pdf-to-img');
const { EPub } = require('epub2');
const path = require('path');
const { removeAccents } = require('./stringUtils');

// ─── PDF Preview ──────────────────────────────────────────────────────────────

async function generatePdfPreview(filePath) {
    console.log(`[Preview] Generating PDF preview for: ${filePath}`);

    const originalWarn = console.warn;
    console.warn = (...args) => {
        const msg = args.join(' ');
        if (
            msg.includes('JBig2Image#instantiateWasm') ||
            msg.includes('Falling back to JS JBIG2 decoder')
        ) return;
        originalWarn(...args);
    };

    try {
        const document = await pdf(filePath, { scale: 1.8 });
        const pages = [];
        let count = 0;

        for await (const page of document) {
            if (count >= 5) break;
            pages.push(`data:image/png;base64,${page.toString('base64')}`);
            count++;
        }

        console.log(`[Preview] PDF: ${pages.length} pages generated`);
        return { type: 'pdf', images: pages };
    } catch (err) {
        console.error(`[Preview] PDF failed: ${err.message}`);
        return null;
    } finally {
        console.warn = originalWarn;
    }
}

// ─── EPUB Helpers ─────────────────────────────────────────────────────────────

function getChapterAsync(epub, chapterId) {
    return new Promise((resolve) => {
        epub.getChapter(chapterId, (err, data) => {
            resolve(err ? '' : (data || ''));
        });
    });
}

/**
 * Extract inline stylesheets bundled inside the epub.
 * epub2 stores manifest items; we find all CSS entries and read them.
 */
async function extractEpubStyles(epub) {
    return new Promise((resolve) => {
        const cssItems = Object.values(epub.manifest || {}).filter(
            (item) => item['media-type'] === 'text/css'
        );

        if (cssItems.length === 0) return resolve('');

        let pending = cssItems.length;
        const sheets = [];

        cssItems.forEach((item) => {
            epub.getFile(item.id, (err, data) => {
                if (!err && data) {
                    // Sanitize: remove @font-face (fonts won't load outside epub)
                    // and url() references to local files
                    let css = data.toString('utf8');
                    css = css.replace(/@font-face\s*\{[^}]*\}/gi, '');
                    css = css.replace(/url\(['"]?(?!data:)[^)'"]+['"]?\)/gi, 'none');
                    sheets.push(css);
                }
                if (--pending === 0) resolve(sheets.join('\n'));
            });
        });
    });
}

/**
 * Scoped wrapper: inject epub CSS under a unique class to avoid
 * bleeding into the host page's styles.
 */
function scopeStyles(css, scopeClass) {
    if (!css) return '';
    // Walk by index instead of regex to avoid ReDoS on ([^{}]+)\{
    const out = [];
    let i = 0;
    const len = css.length;

    while (i < len) {
        const braceOpen = css.indexOf('{', i);
        if (braceOpen === -1) { out.push(css.slice(i)); break; }

        const selectors = css.slice(i, braceOpen);
        const braceClose = css.indexOf('}', braceOpen);
        if (braceClose === -1) { out.push(css.slice(i)); break; }

        const body = css.slice(braceOpen, braceClose + 1);

        const scoped = selectors
            .split(',')
            .map((s) => {
                const trimmed = s.trim();
                if (!trimmed || trimmed.startsWith('@')) return trimmed;
                return `.${scopeClass} ${trimmed}`;
            })
            .join(', ');

        out.push(scoped, body);
        i = braceClose + 1;
    }

    return out.join('');
}

/**
 * Strip leading <img> and <svg>...</svg> tags that appear before any real text.
 * Uses indexOf instead of nested-quantifier regex to avoid ReDoS.
 */
function stripLeadingMediaTags(html) {
    let s = html;
    while (true) {
        const trimmed = s.trimStart();
        // Check for <img ...>
        if (/^<img\s/i.test(trimmed)) {
            const end = trimmed.indexOf('>');
            if (end === -1) break;
            s = trimmed.slice(end + 1);
            continue;
        }
        // Check for <svg ...>...</svg>
        if (/^<svg[\s>]/i.test(trimmed)) {
            const closeIdx = trimmed.toLowerCase().indexOf('</svg>');
            if (closeIdx === -1) break;
            s = trimmed.slice(closeIdx + 6);
            continue;
        }
        break;
    }
    return s;
}

/**
 * Strip all HTML tags using indexOf to avoid <[^>]*> ReDoS on malformed input.
 */
function stripAllTags(html) {
    const out = [];
    let i = 0;
    const len = html.length;
    while (i < len) {
        const open = html.indexOf('<', i);
        if (open === -1) { out.push(html.slice(i)); break; }
        if (open > i) out.push(html.slice(i, open));
        const close = html.indexOf('>', open);
        if (close === -1) break; // malformed — stop
        i = close + 1;
    }
    return out.join('');
}

/**
 * Clean chapter HTML:
 * - Remove leading <img> tags (cover / title page art) but keep inline images
 * - Strip <link> and <script> tags (not useful outside epub context)
 * - Strip xml/doctype declarations
 */
function cleanChapterHtml(html) {
    if (!html) return '';

    // Strip doctype / xml declarations
    let cleaned = html.replace(/<\?xml[^>]*\?>/gi, '');
    cleaned = cleaned.replace(/<!DOCTYPE[^>]*>/gi, '');

    // Strip <html>, <head>, <body> wrapper tags but keep their content
    cleaned = cleaned.replace(/<\/?(html|head|body)[^>]*>/gi, '');

    // Strip <link> and <script> (stylesheets are loaded separately via epub manifest)
    cleaned = cleaned.replace(/<link[^>]*>/gi, '');
    cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // Remove leading block-level images (covers): walk forward and drop
    // <img> / <svg>...</svg> that appear before any real text content.
    // Using indexOf instead of regex to avoid nested-quantifier ReDoS.
    cleaned = stripLeadingMediaTags(cleaned);

    // Check there's actual text content — strip tags with a simple
    // indexOf-based walk instead of <[^>]*> which can backtrack on long inputs.
    const textOnly = stripAllTags(cleaned).trim();
    if (textOnly.length < 10) return '';

    return cleaned.trim();
}

function isTableOfContents(chap, content, textOnly) {
    const id = (chap.id || '').toLowerCase();
    const href = (chap.href || '').toLowerCase();
    const title = (chap.title || '').toLowerCase();

    const tocKeywords = [
        'toc', 'nav', 'tableofcontent', 'table-of-content',
        'tableofcontents', 'table-of-contents', 'mucluc',
        'mục lục', 'table_of_contents'
    ];

    if (tocKeywords.some(kw => id.includes(kw) || href.includes(kw) || title.includes(kw))) {
        return true;
    }

    const cleanTextOnly = removeAccents(textOnly);
    const lines = cleanTextOnly.split('\n').map(l => l.trim()).filter(Boolean);

    for (let i = 0; i < Math.min(lines.length, 15); i++) {
        const line = lines[i];
        if (line === 'muc luc' || line === 'table of contents' || line === 'contents' || line === 'muc luc:') {
            return true;
        }
    }

    const linkCount = (content.match(/<a\s/gi) || []).length;
    if (linkCount > 5) {
        const textLen = textOnly.length;
        if (textLen / linkCount < 80) {
            if (cleanTextOnly.includes('muc luc') || cleanTextOnly.includes('contents') || cleanTextOnly.includes('chuong') || cleanTextOnly.includes('chapter')) {
                return true;
            }
        }
    }

    return false;
}

// ─── EPUB Preview ─────────────────────────────────────────────────────────────

async function generateEpubPreview(filePath) {
    console.log(`[Preview] Generating EPUB preview for: ${filePath}`);

    return new Promise((resolve) => {
        const epub = new EPub(filePath);

        epub.on('error', (err) => {
            console.error(`[Preview] EPUB parse error: ${err.message}`);
            resolve(null);
        });

        epub.on('end', async () => {
            try {
                // Extract and scope the epub's own CSS
                const rawCss = await extractEpubStyles(epub);
                const scopeClass = 'epub-content';
                const scopedCss = scopeStyles(rawCss, scopeClass);

                const MAX_CHARS = 12000;
                let totalChars = 0;
                const chapters = [];

                for (const chap of epub.flow) {
                    if (totalChars >= MAX_CHARS || chapters.length >= 4) break;

                    const raw = await getChapterAsync(epub, chap.id);
                    let content = cleanChapterHtml(raw);
                    if (!content) continue;

                    const textOnly = stripAllTags(content).trim();
                    if (isTableOfContents(chap, content, textOnly)) {
                        console.log(`[Preview] Skipping TOC chapter: id=${chap.id}, href=${chap.href}`);
                        continue;
                    }

                    // Trim to char budget
                    if (totalChars + content.length > MAX_CHARS) {
                        const remaining = MAX_CHARS - totalChars;
                        // Try to cut at a paragraph boundary
                        let cut = content.indexOf('</p>', remaining);
                        if (cut === -1 || cut > remaining + 1500) cut = remaining;
                        else cut += 4;
                        content =
                            content.substring(0, cut) +
                            '<p class="epub-preview-ellipsis">… preview ends here</p>';
                    }

                    chapters.push({ id: chap.id, content });
                    totalChars += content.length;
                }

                console.log(
                    `[Preview] EPUB: ${chapters.length} chapters, ~${totalChars} chars, CSS: ${rawCss.length} bytes`
                );
                resolve({ type: 'epub', chapters, scopeClass, css: scopedCss });
            } catch (err) {
                console.error(`[Preview] EPUB finalization error: ${err.message}`);
                resolve(null);
            }
        });

        epub.parse();
    });
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function getPreview(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') return generatePdfPreview(filePath);
    if (ext === '.epub') return generateEpubPreview(filePath);
    return null;
}

module.exports = { getPreview };