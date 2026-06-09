const express = require('express');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const { getBookMetadata } = require('./scanner');
const { setupHeaders, getAllBooks, addOrUpdateBook } = require('./sheets');
const { getPreview } = require('./utils/preview');
const { scrapeGoodreads } = require('./utils/scraper');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const BOOKS_PATH = process.env.BOOKS_PATH;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const COVERS_PATH = path.join(__dirname, '../data/covers');
const PREVIEWS_PATH = path.join(__dirname, '../data/previews');

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/covers', express.static(COVERS_PATH));
app.use('/previews', express.static(PREVIEWS_PATH));

const SUPPORTED_EXTENSIONS = ['.pdf', '.epub', '.mobi', '.azw', '.azw3'];

let isScanning = false;
let scanResults = { total: 0, processed: 0, added: 0, skipped: 0, errors: 0 };

/**
 * Utility to wait
 */
const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * ASYNC Recursive Scanner with SKIP logic and THROTTLING
 */
async function startAsyncScan(dir, existingBooksMap) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const res = path.resolve(dir, entry.name);
            if (entry.isDirectory()) {
                await startAsyncScan(res, existingBooksMap);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (SUPPORTED_EXTENSIONS.includes(ext)) {
                    scanResults.total++;
                    const fileName = entry.name;
                    
                    // Calculate relative path from BOOKS_PATH
                    const relativePath = path.relative(BOOKS_PATH, res);
                    const existingBook = existingBooksMap.get(relativePath);

                    // 1. SKIP LOGIC: 
                    // Skip if:
                    // - Book has a cover AND
                    // - Book metadata source is OpenLibrary (already fetched)
                    // BUT: If user provided a goodreadsId manually, we should attempt a fetch if it wasn't fetched yet.
                    const hasCover = existingBook && existingBook.cover && existingBook.cover !== 'null';
                    const isFetched = existingBook && existingBook.source === 'OpenLibrary';
                    const hasGoodreadsId = existingBook && existingBook.goodreadsId;

                    if (existingBook && hasCover && isFetched && (!hasGoodreadsId || (hasGoodreadsId && existingBook.source === 'OpenLibrary'))) {
                        console.log(`[Scanner] Skipping (${scanResults.total}): ${fileName} (Complete)`);
                        scanResults.skipped++;
                        scanResults.processed++;
                        continue;
                    }
                    
                    if (existingBook) {
                        if (!hasCover) {
                            console.log(`[Scanner] Existing Book Found but No Cover (${scanResults.total}): ${fileName}. Attempting extraction/fetch...`);
                        } else if (hasGoodreadsId && !isFetched) {
                            console.log(`[Scanner] Existing Book Found with Goodreads ID (${scanResults.total}): ${fileName}. Fetching metadata...`);
                        }
                    } else {
                        console.log(`[Scanner] New Book Found (${scanResults.total}): ${fileName}`);
                    }
                    
                    try {
                        // 2. THROTTLING: Wait 2s
                        await delay(2000);
                        
                        const metadata = await getBookMetadata(
                            fileName, 
                            relativePath, 
                            res, 
                            COVERS_PATH, 
                            existingBook ? existingBook.goodreadsId : ''
                        );
                        
                        // If it's an existing book, preserve its manual status and other fields if possible
                        if (existingBook) {
                            metadata.status = existingBook.status;
                            metadata.rowIndex = existingBook.rowIndex;
                            // Only update if we actually found a new cover or info
                            if (!metadata.cover && existingBook.cover) metadata.cover = existingBook.cover;
                        }

                        await addOrUpdateBook(SHEET_ID, metadata);
                        scanResults.added++;
                    } catch (err) {
                        console.error(`[Scanner Error] ${fileName}:`, err.message);
                        scanResults.errors++;
                    }
                    scanResults.processed++;
                }
            }
        }
    } catch (err) {
        console.error(`[Scanner Directory Error] ${dir}:`, err.message);
    }
}

app.get('/api/scan', async (req, res) => {
    if (isScanning) {
        return res.json({ message: 'Scan already in progress', results: scanResults });
    }

    isScanning = true;
    scanResults = { total: 0, processed: 0, added: 0, skipped: 0, errors: 0 };

    (async () => {
        console.log(`\n🚀 [Fast Scanner] Loading existing books...`);
        await setupHeaders(SHEET_ID);
        const existingBooks = await getAllBooks(SHEET_ID);
        const existingBooksMap = new Map(existingBooks.map(b => [b.location, b]));
        console.log(`[Fast Scanner] Loaded ${existingBooksMap.size} existing books. Starting NAS scan...\n`);

        await startAsyncScan(BOOKS_PATH, existingBooksMap);
        
        console.log(`\n✅ [Fast Scanner] Finished.`);
        console.log(`Total Found: ${scanResults.total}`);
        console.log(`Skipped (Complete): ${scanResults.skipped}`);
        console.log(`Added/Updated: ${scanResults.added}`);
        console.log(`Errors: ${scanResults.errors}\n`);
        isScanning = false;
    })();

    res.json({ message: 'Scan started in background', results: scanResults });
});

app.get('/api/scan/status', (req, res) => {
    res.json({ isScanning, results: scanResults });
});

app.get('/api/books', async (req, res) => {
    try {
        const books = await getAllBooks(SHEET_ID);
        res.json(books);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/preview/:rowIndex', async (req, res) => {
    try {
        const rowIndex = parseInt(req.params.rowIndex);
        const books = await getAllBooks(SHEET_ID);
        const book = books.find(b => b.rowIndex === rowIndex);
        
        if (!book) {
            return res.status(404).json({ error: 'Book not found' });
        }

        const absolutePath = path.resolve(BOOKS_PATH, book.location);
        const previewData = await getPreview(absolutePath, PREVIEWS_PATH);
        
        if (!previewData) {
            return res.status(500).json({ error: 'Could not generate preview' });
        }

        res.json(previewData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/book', async (req, res) => {
    const { title, author, goodreadsId } = req.query;
    const query = `${title || ''} ${author || ''}`.trim();
    
    if (!query && !goodreadsId) {
        return res.status(400).json({ error: 'Thiếu title hoặc goodreadsId' });
    }

    try {
        const result = await scrapeGoodreads(query, goodreadsId);
        if (!result) return res.status(404).json({ error: 'Không tìm thấy' });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📚 Scanning path: ${BOOKS_PATH}`);
    console.log(`=========================================`);
});
