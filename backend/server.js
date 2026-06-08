const express = require('express');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const { getBookMetadata } = require('./scanner');
const { setupHeaders, getAllBooks, addOrUpdateBook } = require('./sheets');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const BOOKS_PATH = process.env.BOOKS_PATH;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

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
async function startAsyncScan(dir, existingFileNames) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const res = path.resolve(dir, entry.name);
            if (entry.isDirectory()) {
                await startAsyncScan(res, existingFileNames);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (SUPPORTED_EXTENSIONS.includes(ext)) {
                    scanResults.total++;
                    const fileName = entry.name;

                    // 1. SKIP LOGIC: If already in Sheets, skip to save API quota
                    if (existingFileNames.has(fileName)) {
                        console.log(`[Scanner] Skipping (${scanResults.total}): ${fileName} (Already in Database)`);
                        scanResults.skipped++;
                        scanResults.processed++;
                        continue;
                    }
                    
                    console.log(`[Scanner] New Book Found (${scanResults.total}): ${fileName}`);
                    
                    try {
                        // 2. THROTTLING: Wait 3s to be safer with API limits (Google Books 429)
                        await delay(3000);
                        
                        const metadata = await getBookMetadata(fileName);
                        metadata.fileName = fileName;
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
        const existingFileNames = new Set(existingBooks.map(b => b.fileName));
        console.log(`[Fast Scanner] Loaded ${existingFileNames.size} existing books. Starting NAS scan...\n`);

        await startAsyncScan(BOOKS_PATH, existingFileNames);
        
        console.log(`\n✅ [Fast Scanner] Finished.`);
        console.log(`Total Found: ${scanResults.total}`);
        console.log(`Skipped (Existing): ${scanResults.skipped}`);
        console.log(`Added (New): ${scanResults.added}`);
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

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📚 Scanning path: ${BOOKS_PATH}`);
    console.log(`=========================================`);
});
