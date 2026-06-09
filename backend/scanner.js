const path = require('path');
const fs = require('fs');
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
 * Fast function to get basic info from filename + file stats.
 */
function getBasicInfo(filename, relativePath, absolutePath) {
    const parsed = parseFilename(filename);
    const stats = fs.statSync(absolutePath);
    
    return {
        title: parsed.title,
        author: parsed.author,
        year: 'N/A',
        rating: 'N/A',
        ratingCount: '',
        size: (stats.size / (1024 * 1024)).toFixed(2), // MB
        cover: null,
        source: 'Filename Parser',
        extension: parsed.extension,
        location: relativePath,
        goodreadsCheck: 'No',
        goodreadsId: ''
    };
}

/**
 * Fetches metadata from Goodreads using a scraper.
 */
async function getBookMetadata(filename, relativePath, goodreadsId = '', basicInfo = null) {
    const info = basicInfo || { title: filename, author: 'Unknown' };

    let metadata = {
        ...info,
        goodreadsCheck: 'Yes',
        goodreadsId: goodreadsId
    };

    // 1. Lookup on Goodreads
    const searchQuery = `${info.title} ${info.author !== 'Unknown' ? info.author : ''}`.trim();
    const result = await scrapeGoodreads(searchQuery, goodreadsId);

    if (result) {
        console.log(`[Scanner] Found match on Goodreads: ${result.title}`);
        metadata.title = result.title;
        metadata.author = result.author || info.author;
        metadata.year = result.year || 'N/A';
        metadata.rating = result.rating || 'N/A';
        metadata.ratingCount = result.ratingCount || '';
        metadata.source = 'Goodreads';
        metadata.goodreadsId = result.goodreadsId || goodreadsId;
        metadata.cover = result.cover || null;
    } else {
        console.log(`[Scanner] No match found on Goodreads for: ${filename}`);
    }

    return metadata;
}

module.exports = { parseFilename, getBookMetadata, getBasicInfo };
