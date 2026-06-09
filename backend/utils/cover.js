const { EPub } = require('epub2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Extracts cover from EPUB file.
 */
async function extractEpubCover(filePath, outputDir) {
    return new Promise((resolve) => {
        const epub = new EPub(filePath);
        
        epub.on('error', (err) => {
            console.error(`[Cover Extractor] EPUB Error: ${err.message}`);
            resolve(null);
        });

        epub.on('end', () => {
            const coverId = epub.metadata.cover;
            if (!coverId) {
                console.log(`[Cover Extractor] No cover metadata found for: ${path.basename(filePath)}`);
                return resolve(null);
            }

            console.log(`[Cover Extractor] Found cover ID "${coverId}" for: ${path.basename(filePath)}. Extracting...`);
            epub.getImage(coverId, (err, data, mimeType) => {
                if (err) {
                    console.error(`[Cover Extractor] Error getting image for ${coverId}: ${err.message}`);
                    return resolve(null);
                }
                if (!data) {
                    console.error(`[Cover Extractor] No data returned for cover image ${coverId}`);
                    return resolve(null);
                }

                const hash = crypto.createHash('sha256').update(filePath).digest('hex');
                const ext = mimeType.split('/')[1] || 'jpg';
                const fileName = `${hash}.${ext}`;
                const outputPath = path.join(outputDir, fileName);

                fs.writeFileSync(outputPath, data);
                console.log(`[Cover Extractor] Successfully saved cover to: ${fileName}`);
                resolve(`/covers/${fileName}`);
            });
        });

        epub.parse();
    });
}

/**
 * Main function to extract cover based on file extension.
 */
async function extractEmbeddedCover(filePath, outputDir) {
    const ext = path.extname(filePath).toLowerCase();
    
    try {
        if (ext === '.epub') {
            return await extractEpubCover(filePath, outputDir);
        }
        // Add more formats here later (MOBI, PDF, etc.)
    } catch (err) {
        console.error(`[Cover Extractor] Failed for ${filePath}: ${err.message}`);
    }

    return null;
}

module.exports = { extractEmbeddedCover };
