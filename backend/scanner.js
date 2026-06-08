const axios = require('axios');
const path = require('path');
const cheerio = require('cheerio');

/**
 * Normalizes a string: removes Vietnamese accents and special characters.
 * Useful for cleaner API searching.
 */
function normalizeString(str) {
    if (!str) return '';
    return str.normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/đ/g, "d").replace(/Đ/g, "D")
              .replace(/[^a-zA-Z0-9\s]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
}

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
    let author = '';

    // 4. Handle "Title - Author" or "Author - Title"
    if (name.includes(' - ')) {
        const parts = name.split(' - ');
        // Heuristic: usually the API search will help clarify, 
        // but for now we store them as parts[0] and parts[1]
        title = parts[0].trim();
        author = parts[1].trim();
    }

    return { 
        raw: name, 
        title, 
        author, 
        normalizedTitle: normalizeString(title),
        normalizedAuthor: normalizeString(author),
        extension: ext 
    };
}

async function fetchFromOpenLibrary(title, author = '', normalizedTitle = '') {
    try {
        // Try searching with normalized title if original has special characters
        const searchTitle = normalizedTitle || title;
        const query = author ? `title=${encodeURIComponent(searchTitle)}&author=${encodeURIComponent(author)}` : `title=${encodeURIComponent(searchTitle)}`;
        const url = `https://openlibrary.org/search.json?${query}`;
        
        console.log(`[OpenLibrary] Searching: ${url}`);
        const response = await axios.get(url, { timeout: 5000 });
        const docs = response.data.docs;

        // If no results with (Title, Author), try just (Title) or (Author, Title) swapped
        if ((!docs || docs.length === 0) && author) {
            console.log(`[OpenLibrary] No results. Trying swapped Title/Author...`);
            const swappedUrl = `https://openlibrary.org/search.json?title=${encodeURIComponent(author)}&author=${encodeURIComponent(searchTitle)}`;
            const swappedRes = await axios.get(swappedUrl, { timeout: 5000 });
            if (swappedRes.data.docs && swappedRes.data.docs.length > 0) {
                return formatOLResult(swappedRes.data.docs[0]);
            }
        }

        if (docs && docs.length > 0) {
            return formatOLResult(docs[0]);
        }
    } catch (error) {
        console.error(`[OpenLibrary Error] ${error.message}`);
    }
    return null;
}

function formatOLResult(first) {
    return {
        title: first.title,
        author: first.author_name ? first.author_name[0] : 'Unknown',
        year: first.first_publish_year || 'N/A',
        cover: first.cover_i ? `https://covers.openlibrary.org/b/id/${first.cover_i}-L.jpg` : null,
        rating: first.ratings_average ? first.ratings_average.toFixed(1) : 'N/A',
        source: 'Open Library'
    };
}

async function fetchFromGoogleBooks(title, author = '', normalizedTitle = '') {
    try {
        const searchTitle = normalizedTitle || title;
        const query = author ? `intitle:${searchTitle}+inauthor:${author}` : `intitle:${searchTitle}`;
        const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`;
        
        console.log(`[GoogleBooks] Searching: ${url}`);
        const response = await axios.get(url, { timeout: 5000 });
        const items = response.data.items;

        if (!items || items.length === 0) {
            // Swap check
            const swappedQuery = `intitle:${author}+inauthor:${searchTitle}`;
            const swappedRes = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(swappedQuery)}&maxResults=1`, { timeout: 5000 });
            if (swappedRes.data.items && swappedRes.data.items.length > 0) {
                return formatGBResult(swappedRes.data.items[0]);
            }
        }

        if (items && items.length > 0) {
            return formatGBResult(items[0]);
        }
    } catch (error) {
        console.error(`[GoogleBooks Error] ${error.message}`);
    }
    return null;
}

function formatGBResult(item) {
    const volumeInfo = item.volumeInfo;
    return {
        title: volumeInfo.title,
        author: volumeInfo.authors ? volumeInfo.authors[0] : 'Unknown',
        year: volumeInfo.publishedDate ? volumeInfo.publishedDate.split('-')[0] : 'N/A',
        cover: volumeInfo.imageLinks ? volumeInfo.imageLinks.thumbnail.replace('http:', 'https:') : null,
        rating: volumeInfo.averageRating || 'N/A',
        source: 'Google Books'
    };
}

async function fetchFromGoodreads(title, author = '', normalizedTitle = '') {
    try {
        const searchTitle = normalizedTitle || title;
        const query = author ? `${searchTitle} ${author}` : searchTitle;
        const url = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}`;
        
        console.log(`[Goodreads] Scraping: ${url}`);
        
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/'
            }
        });

        const $ = cheerio.load(response.data);
        // Goodreads search results are in a table with class 'tableList'
        const firstResult = $('table.tableList tr[itemscope][itemtype="http://schema.org/Book"]').first();

        if (firstResult.length > 0) {
            // Precise selectors based on the HTML structure
            const bookTitle = firstResult.find('a.bookTitle span[itemprop="name"]').text().trim();
            const bookAuthor = firstResult.find('a.authorName span[itemprop="name"]').first().text().trim();
            
            // Container for rating and year
            const infoContainer = firstResult.find('span.minirating').parent();
            const infoText = infoContainer.text().trim();
            
            // Extract cover and get large version
            let coverImg = firstResult.find('img.bookCover').attr('src');
            if (coverImg) {
                // Remove Goodreads thumbnail suffixes to get original image
                // Examples: ._SX50_.jpg, ._SY75_.jpg, ._SX50_SY75_.jpg
                coverImg = coverImg.split('._S')[0] + '.jpg';
            }

            // Parse rating (e.g., "3.81 avg rating")
            // eslint-disable-next-line sonarjs/slow-regex
            const ratingMatch = infoText.match(/(\d+\.\d+) avg rating/);
            const rating = ratingMatch ? ratingMatch[1] : 'N/A';

            // Extract year (e.g., "published 1998" or "— 1998 —")
            const yearMatch = infoText.match(/published (\d{4})/i) || infoText.match(/— (\d{4}) —/);
            const year = yearMatch ? yearMatch[1] : 'N/A';

            console.log(`[Goodreads] Found: ${bookTitle} by ${bookAuthor} (${rating}⭐, ${year})`);

            return {
                title: bookTitle,
                author: bookAuthor,
                year: year,
                cover: coverImg,
                rating: rating,
                source: 'Goodreads'
            };
        }
    } catch (error) {
        console.error(`[Goodreads Error] ${error.message}`);
    }
    return null;
}

async function getBookMetadata(filename) {
    const parsed = parseFilename(filename);
    
    // 1. Try Goodreads first as requested
    let metadata = await fetchFromGoodreads(parsed.title, parsed.author, parsed.normalizedTitle);
    
    // 2. Fallback to Open Library
    if (!metadata) {
        metadata = await fetchFromOpenLibrary(parsed.title, parsed.author, parsed.normalizedTitle);
    }
    
    // 3. Fallback to Google Books
    if (!metadata) {
        metadata = await fetchFromGoogleBooks(parsed.title, parsed.author, parsed.normalizedTitle);
    }

    // If still no metadata, return basic info from filename
    if (!metadata) {
        return {
            title: parsed.title,
            author: parsed.author || 'Unknown',
            year: 'N/A',
            cover: null,
            rating: 'N/A',
            source: 'Filename Parser'
        };
    }

    return metadata;
}

module.exports = { parseFilename, getBookMetadata };
