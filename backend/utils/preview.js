const { pdf } = require('pdf-to-img');
const { EPub } = require('epub2');
const path = require('path');

/**
 * Generates preview for PDF (first 5 pages as images) on-the-fly.
 */
async function generatePdfPreview(filePath) {
    console.log(`[Preview] Generating PDF preview for: ${filePath}`);
    try {
        const document = await pdf(filePath, { scale: 1.2 });
        const pages = [];
        let count = 0;
        
        for await (const page of document) {
            if (count >= 5) break;
            // Convert Buffer to Base64 to send in JSON
            const base64 = `data:image/png;base64,${page.toString('base64')}`;
            pages.push(base64);
            count++;
        }
        console.log(`[Preview] PDF Success: ${pages.length} pages generated`);
        return { type: 'pdf', images: pages };
    } catch (err) {
        console.error(`[Preview] PDF Generation Failed: ${err.message}`);
        return null;
    }
}

/**
 * Promisified getChapter for EPub
 */
async function getChapterAsync(epub, chapterId) {
    return new Promise((resolve) => {
        epub.getChapter(chapterId, (err, data) => {
            if (err) resolve('');
            else resolve(data || '');
        });
    });
}

/**
 * Clean HTML content for preview: remove initial images and empty tags.
 */
function cleanContent(html) {
    if (!html) return '';
    
    // Remove <img> tags from the beginning of the content
    // Some books have giant covers or icons at the start
    let cleaned = html.replace(/<img[^>]*>/gi, '');
    
    // Check if there is actual text content
    const textOnly = cleaned.replace(/<[^>]*>?/gm, '').trim();
    if (textOnly.length < 5) return ''; // Too little text, ignore this part

    return cleaned.trim();
}

/**
 * Generates preview for EPUB (first few pages equivalent) on-the-fly.
 */
async function generateEpubPreview(filePath) {
    console.log(`[Preview] Generating EPUB preview for: ${filePath}`);
    return new Promise((resolve) => {
        const epub = new EPub(filePath);
        
        epub.on('error', (err) => {
            console.error(`[Preview] EPUB Parsing Error for ${path.basename(filePath)}: ${err.message}`);
            resolve(null);
        });

        epub.on('end', async () => {
            try {
                const MAX_CHARS = 10000; 
                let totalChars = 0;
                const chapters = [];
                let foundText = false;

                for (const chap of epub.flow) {
                    if (totalChars >= MAX_CHARS || chapters.length >= 3) break;

                    let text = await getChapterAsync(epub, chap.id);
                    
                    // CLEANING LOGIC: 
                    // Skip parts that are just images or empty (covers/title pages)
                    const cleanedText = cleanContent(text);
                    if (!foundText && !cleanedText) continue;
                    
                    foundText = true; // Once we find the first real text, we take everything following
                    text = cleanedText || text;

                    if (totalChars + text.length > MAX_CHARS) {
                        const remaining = MAX_CHARS - totalChars;
                        let breakPoint = text.indexOf('</p>', remaining);
                        if (breakPoint === -1 || breakPoint > remaining + 1000) {
                            breakPoint = remaining;
                        } else {
                            breakPoint += 4; 
                        }
                        text = text.substring(0, breakPoint) + '<p class="text-slate-500 italic mt-4">... [Preview ends here]</p>';
                    }

                    chapters.push({
                        id: chap.id,
                        content: text
                    });
                    totalChars += text.length;
                }

                console.log(`[Preview] EPUB Success: ${chapters.length} chapters processed (~${totalChars} chars)`);
                resolve({ type: 'epub', chapters });
            } catch (err) {
                console.error(`[Preview] EPUB Finalization Error: ${err.message}`);
                resolve(null);
            }
        });

        epub.parse();
    });
}

/**
 * Main preview router (on-the-fly)
 */
async function getPreview(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
        return await generatePdfPreview(filePath);
    } else if (ext === '.epub') {
        return await generateEpubPreview(filePath);
    }
    return null;
}

module.exports = { getPreview };
