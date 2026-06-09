const { pdf } = require('pdf-to-img');
const { EPub } = require('epub2');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Generates preview for PDF (first 5 pages as images).
 */
async function generatePdfPreview(filePath, outputDir) {
    const hash = crypto.createHash('sha256').update(filePath).digest('hex');
    const previewDir = path.join(outputDir, hash);
    
    // Check if already exists
    try {
        await fs.access(previewDir);
        const files = await fs.readdir(previewDir);
        if (files.length > 0) {
            return files.map(f => `/previews/${hash}/${f}`).sort();
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`[Preview] Access error: ${err.message}`);
        }
        // Directory doesn't exist, create it
        await fs.mkdir(previewDir, { recursive: true });
    }

    try {
        const document = await pdf(filePath, { scale: 1.5 });
        const pages = [];
        let count = 0;
        
        for await (const page of document) {
            if (count >= 5) break;
            const fileName = `page-${count + 1}.png`;
            const outputPath = path.join(previewDir, fileName);
            await fs.writeFile(outputPath, page);
            pages.push(`/previews/${hash}/${fileName}`);
            count++;
        }
        return pages;
    } catch (err) {
        console.error(`[Preview] PDF Error: ${err.message}`);
        return [];
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
 * Generates preview for EPUB (first 3 chapters as HTML).
 */
async function generateEpubPreview(filePath, outputDir) {
    const hash = crypto.createHash('sha256').update(filePath).digest('hex');
    const previewFile = path.join(outputDir, `${hash}.json`);

    try {
        await fs.access(previewFile);
        const data = await fs.readFile(previewFile, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`[Preview] Cache read error: ${err.message}`);
        }
        // File doesn't exist or is invalid, continue to generate
    }

    return new Promise((resolve) => {
        const epub = new EPub(filePath);
        
        epub.on('error', (err) => {
            console.error(`[Preview] EPUB Error: ${err.message}`);
            resolve(null);
        });

        epub.on('end', async () => {
            try {
                // Get first chapter(s) but limit total content to ~5 pages equivalent
                // 1 page is roughly 2000 chars in HTML including tags
                const MAX_CHARS = 10000; 
                let totalChars = 0;
                const chapters = [];

                for (const chap of epub.flow) {
                    if (totalChars >= MAX_CHARS || chapters.length >= 3) break;

                    let text = await getChapterAsync(epub, chap.id);

                    // If this chapter would put us way over, truncate it
                    if (totalChars + text.length > MAX_CHARS) {
                        const remaining = MAX_CHARS - totalChars;
                        // Try to find a good breaking point (end of paragraph)
                        let breakPoint = text.indexOf('</p>', remaining);
                        if (breakPoint === -1 || breakPoint > remaining + 1000) {
                            breakPoint = remaining;
                        } else {
                            breakPoint += 4; // Include </p>
                        }
                        text = text.substring(0, breakPoint) + '<p class="text-slate-500 italic mt-4">... [Preview ends here]</p>';
                    }

                    chapters.push({
                        id: chap.id,
                        title: chap.title || 'Chapter',
                        content: text
                    });
                    totalChars += text.length;
                }

                const result = { type: 'epub', chapters };
                await fs.writeFile(previewFile, JSON.stringify(result));
                resolve(result);
            } catch (err) {
                console.error(`[Preview] EPUB Processing Error: ${err.message}`);
                resolve(null);
            }
        });

        epub.parse();
    });
}

/**
 * Main preview router
 */
async function getPreview(filePath, outputDir) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
        const images = await generatePdfPreview(filePath, outputDir);
        return { type: 'pdf', images };
    } else if (ext === '.epub') {
        return await generateEpubPreview(filePath, outputDir);
    }
    return null;
}

module.exports = { getPreview };
