const { EPub } = require('epub2');
const path = require('path');

/**
 * Extracts cover from EPUB file as Buffer.
 */
async function extractEpubCover(filePath) {
    return new Promise((resolve) => {
        const epub = new EPub(filePath);
        
        epub.on('error', (err) => {
            console.error(`[Cover Extractor] EPUB Error: ${err.message}`);
            resolve(null);
        });

        epub.on('end', () => {
            const coverId = epub.metadata.cover;
            if (!coverId) {
                return resolve(null);
            }

            epub.getImage(coverId, (err, data, mimeType) => {
                if (err || !data) {
                    return resolve(null);
                }
                resolve({ data, mimeType: mimeType || 'image/jpeg' });
            });
        });

        epub.parse();
    });
}

/**
 * Main function to extract cover as Buffer on-the-fly.
 */
async function extractEmbeddedCover(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    
    try {
        if (ext === '.epub') {
            return await extractEpubCover(filePath);
        }
        // Add more formats here later (MOBI, PDF, etc.)
    } catch (err) {
        console.error(`[Cover Extractor] Failed for ${filePath}: ${err.message}`);
    }

    return null;
}

module.exports = { extractEmbeddedCover };
