const path = require('path');
const { extractEmbeddedCover } = require('./utils/cover');
const { scrapeGoodreads } = require('./utils/scraper');

/**
 * Parses a filename to extract title and author.
 */
function parseFilename(filename) {
    const ext = path.extname(filename);
    let name = path.basename(filename, ext);

    // 1. Remove common garbage like [EPUB], (2023), etc.
    // eslint-disable-next-line sonarjs/slow-regex
    name = name.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim();
    
    // 2. Strip leading numbers like "01. ", "1 - ", "123 "
    name = name.replace(/^\d+[\s.-]+/, '').trim();

    // 3. Replace underscores or multiple dots with spaces
    name = name.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

    let title = name;
    let author = 'Unknown';

    // 4. Handle "Title - Author" or "Author - Title"
    if (name.includes(' - ')) {
        const parts = name.split(' - ');
        title = parts[0].trim();
        author = parts[1].trim();
    }

    return { 
        title, 
        author,
        extension: ext 
    };
}

/**
 * Fetches metadata from Goodreads using a scraper.
 * Prioritizes embedded cover extraction.
 */
async function getBookMetadata(filename, relativePath, absolutePath, coversDir, goodreadsId = '') {
    const parsed = parseFilename(filename);
    
    // 1. Try to extract embedded cover first
    const embeddedCover = await extractEmbeddedCover(absolutePath, coversDir);

    let metadata = {
        title: parsed.title,
        author: parsed.author,
        year: 'N/A',
        cover: embeddedCover,
        rating: 'N/A',
        source: 'Filename Parser',
        extension: parsed.extension,
        location: relativePath,
        goodreadsCheck: 'Yes',
        goodreadsId: goodreadsId
    };

    // 2. Lookup on Goodreads
    // If goodreadsId is provided, we use it directly in the scraper
    const searchQuery = `${parsed.title} ${parsed.author !== 'Unknown' ? parsed.author : ''}`.trim();
    const result = await scrapeGoodreads(searchQuery, goodreadsId);

    if (result) {
        console.log(`[Scanner] Found match on Goodreads: ${result.title}`);
        metadata.title = result.title;
        metadata.author = result.author || parsed.author;
        metadata.year = result.year || 'N/A';
        metadata.rating = result.rating || 'N/A';
        metadata.source = 'Goodreads';
        metadata.goodreadsId = result.goodreadsId || goodreadsId;
        
        // Only use Goodreads cover if we didn't find an embedded one
        if (!metadata.cover && result.cover) {
            metadata.cover = result.cover;
        }
    } else {
        console.log(`[Scanner] No match found on Goodreads for: ${filename}`);
    }

    return metadata;
}

module.exports = { parseFilename, getBookMetadata };
