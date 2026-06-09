const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const mime = require('mime-types');
require('dotenv').config();

const { getBookMetadata, getBasicInfo } = require('./scanner');
const { setupHeaders, getAllBooks, addOrUpdateBook } = require('./sheets');
const { getPreview } = require('./utils/preview');
const { extractEmbeddedCover } = require('./utils/cover');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const BOOKS_PATH = process.env.BOOKS_PATH;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const ERR_BOOK_NOT_FOUND = 'Book not found';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const SUPPORTED_EXTENSIONS = ['.pdf', '.epub', '.mobi', '.azw', '.azw3'];

let isScanning = false;
let isEnriching = false;
let scanResults = { total: 0, processed: 0, added: 0, skipped: 0, errors: 0 };
let enrichResults = { total: 0, current: 0, currentTitle: '' };

const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Background worker to enrich metadata
 */
async function enrichMetadataWorker(spreadsheetId, sharedBooksCache = null) {
    if (isEnriching) return;
    isEnriching = true;
    try {
        console.log(`\n🧵 [Enricher] Active.`);
        const books = sharedBooksCache || await getAllBooks(spreadsheetId);
        while (isScanning || books.some(b => b.goodreadsCheck === 'No' || (b.goodreadsId && b.source === 'Filename Parser'))) {
            const pending = books.filter(b => 
                b.goodreadsCheck === 'No' || 
                (b.goodreadsId && b.source === 'Filename Parser')
            );
            enrichResults.total = pending.length;
            if (pending.length === 0) {
                if (!isScanning) break; 
                await delay(3000); 
                continue;
            }
            const book = pending[0];
            enrichResults.current++;
            enrichResults.currentTitle = book.title;
            try {
                await delay(5000); 

                // Ensure size is calculated if it was missed
                if (!book.size || book.size === 'N/A' || book.size === '') {
                    try {
                        const absolutePath = path.resolve(BOOKS_PATH, book.location);
                        const stats = await fs.stat(absolutePath);
                        book.size = (stats.size / (1024 * 1024)).toFixed(2);
                    } catch (err) {
                        if (err.code !== 'ENOENT') console.error(`[Enricher] Size fix error: ${err.message}`);
                        book.size = '0.00';
                    }
                }

                const metadata = await getBookMetadata(path.basename(book.location), book.location, book.goodreadsId, book);
                metadata.status = book.status;
                metadata.rowIndex = book.rowIndex;
                // Preserve size from sheet if available, otherwise getBasicInfo inside getBookMetadata handles it
                if (!metadata.size || metadata.size === '0.00' || metadata.size === 'N/A') {
                    metadata.size = book.size;
                }

                await addOrUpdateBook(spreadsheetId, metadata, books);
                const idx = books.findIndex(b => b.location === metadata.location);
                if (idx !== -1) books[idx] = { ...books[idx], ...metadata };
            } catch (err) {
                console.error(`[Enricher Error] ${book.title}:`, err.message);
                const idx = books.findIndex(b => b.location === book.location);
                if (idx !== -1) books[idx].goodreadsCheck = 'Error'; 
            }
            }
            } catch (err) {
            console.error(`[Enricher Fatal Error]`, err.message);
            } finally {
            console.log(`\n✅ [Enricher] Finished.`);
            isEnriching = false;
            enrichResults.currentTitle = '';
            }
            }

/**
 * PHASE 1: Quick Scan
 */
async function startQuickScan(dir, existingBooksMap, allBooksArray) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const res = path.resolve(dir, entry.name);
            if (entry.isDirectory()) {
                await startQuickScan(res, existingBooksMap, allBooksArray);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (SUPPORTED_EXTENSIONS.includes(ext)) {
                    scanResults.total++;
                    const fileName = entry.name;
                    const relativePath = path.relative(BOOKS_PATH, res);
                    const normalizedPath = relativePath.normalize('NFC');

                    if (existingBooksMap.has(normalizedPath)) {
                        const existingBook = existingBooksMap.get(normalizedPath);

                        // Local fix: If book exists but size is missing, calculate and update it
                        if (!existingBook.size || existingBook.size === 'N/A' || existingBook.size === '' || existingBook.size === '0.00') {
                            try {
                                const stats = await fs.stat(res);
                                existingBook.size = (stats.size / (1024 * 1024)).toFixed(2);
                                await addOrUpdateBook(SHEET_ID, existingBook, allBooksArray);
                                console.log(`[Quick Scan] Fixed missing size for: ${fileName}`);
                            } catch (err) {
                                if (err.code !== 'ENOENT') console.error(`[Quick Scan] Size fix error: ${err.message}`);
                            }
                        }

                        scanResults.skipped++;
                    } else {
                        console.log(`[Quick Scan] New: ${fileName}`);
                        const basicInfo = getBasicInfo(fileName, normalizedPath, res);
                        await addOrUpdateBook(SHEET_ID, basicInfo, allBooksArray);
                        const newBook = { ...basicInfo, rowIndex: allBooksArray.length + 2 };
                        allBooksArray.push(newBook);
                        existingBooksMap.set(normalizedPath, newBook);
                        scanResults.added++;
                    }
                    scanResults.processed++;
                }
            }
        }
    } catch (err) {
        console.error(`[Quick Scan Error] ${dir}:`, err.message);
    }
}

app.get('/api/scan', async (req, res) => {
    if (isScanning) return res.json({ message: 'Scan already in progress', results: scanResults });
    isScanning = true;
    scanResults = { total: 0, processed: 0, added: 0, skipped: 0, errors: 0 };
    (async () => {
        try {
            console.log(`\n🚀 [Engine] Starting...`);
            await setupHeaders(SHEET_ID);
            const books = await getAllBooks(SHEET_ID);
            const existingBooksMap = new Map(books.map(b => [(b.location || '').normalize('NFC'), b]));
            enrichMetadataWorker(SHEET_ID, books).catch(err => console.error('[Enricher Startup Error]', err.message));
            await startQuickScan(BOOKS_PATH, existingBooksMap, books);
        } catch (err) {
            console.error('[Scan Error]', err.message);
        } finally {
            isScanning = false;
        }
    })();
    res.json({ message: 'Scan started', results: scanResults });
});

app.get('/api/scan/status', (req, res) => {
    res.json({ isScanning, isEnriching, results: scanResults, enrichment: enrichResults });
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
        if (!book) return res.status(404).json({ error: ERR_BOOK_NOT_FOUND });
        const absolutePath = path.resolve(BOOKS_PATH, book.location);
        const previewData = await getPreview(absolutePath);
        if (!previewData) return res.status(500).json({ error: 'Could not generate preview' });
        res.json(previewData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/cover/:rowIndex', async (req, res) => {
    try {
        const rowIndex = parseInt(req.params.rowIndex);
        const books = await getAllBooks(SHEET_ID);
        const book = books.find(b => b.rowIndex === rowIndex);
        if (!book) return res.status(404).send(ERR_BOOK_NOT_FOUND);
        const absolutePath = path.resolve(BOOKS_PATH, book.location);
        const cover = await extractEmbeddedCover(absolutePath);
        if (!cover) return res.status(404).send('No embedded cover found');
        res.set('Content-Type', cover.mimeType);
        res.send(cover.data);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

app.get('/api/download/:rowIndex', async (req, res) => {
    try {
        const rowIndex = parseInt(req.params.rowIndex);
        const books = await getAllBooks(SHEET_ID);
        const book = books.find(b => b.rowIndex === rowIndex);
        if (!book) return res.status(404).send(ERR_BOOK_NOT_FOUND);
        const absolutePath = path.resolve(BOOKS_PATH, book.location);
        const filename = path.basename(absolutePath);
        const contentType = mime.contentType(path.extname(filename)) || 'application/octet-stream';
        res.setHeader('Content-disposition', 'attachment; filename=' + encodeURIComponent(filename));
        res.setHeader('Content-type', contentType);
        res.sendFile(absolutePath);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📚 Scanning path: ${BOOKS_PATH}`);
    console.log(`=========================================`);
});
