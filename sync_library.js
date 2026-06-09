const fs = require('fs').promises;
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { google } = require('googleapis');
const { parseFilename } = require('./backend/scanner');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const BOOKS_PATH = process.env.BOOKS_PATH;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SUPPORTED_EXTENSIONS = ['.pdf', '.epub', '.mobi', '.azw', '.azw3'];

async function getAuthClient() {
    const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, ''),
        scopes: SCOPES
    });
    return auth;
}

async function scanDirectory(dir, fileList = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const res = path.resolve(dir, entry.name);
        if (entry.isDirectory()) {
            await scanDirectory(res, fileList);
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (SUPPORTED_EXTENSIONS.includes(ext)) {
                fileList.push(res);
            }
        }
    }
    return fileList;
}

async function syncLibrary() {
    console.log("=== STARTING STRICT LIBRARY SYNC ===");
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // 1. Get existing data from Sheets
    console.log("1. Fetching existing books from Google Sheets...");
    let existingRows = [];
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'Sheet1!A2:K'
        });
        existingRows = res.data.values || [];
    } catch (e) {
        console.error("Error fetching sheets:", e.message);
        return;
    }

    // Map by NFC-normalized location to avoid macOS NFD duplication bugs
    const sheetMap = new Map();
    existingRows.forEach(row => {
        const loc = (row[10] || '').normalize('NFC');
        if (loc) {
            // Keep the most "enriched" row if duplicates exist
            if (!sheetMap.has(loc) || (row[0] === 'Yes' && sheetMap.get(loc)[0] !== 'Yes')) {
                sheetMap.set(loc, row);
            }
        }
    });

    // 2. Scan Local Files
    console.log(`2. Scanning local directory: ${BOOKS_PATH}`);
    const localFiles = await scanDirectory(BOOKS_PATH);
    console.log(`   Found ${localFiles.length} local ebook files.`);

    // 3. Merge Data
    console.log("3. Merging local files with sheet data...");
    const finalRows = [];
    
    for (const filePath of localFiles) {
        const relativePath = path.relative(BOOKS_PATH, filePath);
        const locNormalized = relativePath.normalize('NFC');
        
        let sizeMB = '0.00';
        try {
            const stats = await fs.stat(filePath);
            sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        } catch(e) {}

        const parsed = parseFilename(path.basename(filePath));
        const existingRow = sheetMap.get(locNormalized);
        
        if (existingRow) {
            // Preserve Goodreads data, update size and basic info if missing
            const check = existingRow[0] || 'No';
            const id = existingRow[1] || '';
            const title = existingRow[2] || parsed.title;
            const author = existingRow[3] || parsed.author;
            const year = existingRow[4] || 'N/A';
            const rating = existingRow[5] || 'N/A';
            const ratingCount = existingRow[6] || '';
            const cover = existingRow[7] || '';
            const source = existingRow[8] || 'Filename Parser';
            const size = (!existingRow[9] || existingRow[9] === 'N/A' || existingRow[9] === '0.00') ? sizeMB : existingRow[9];
            
            // Always use the exact local relativePath to fix any sheet encoding drift
            finalRows.push([check, id, title, author, year, rating, ratingCount, cover, source, size, relativePath]);
        } else {
            // New Book
            finalRows.push(['No', '', parsed.title, parsed.author, 'N/A', 'N/A', '', '', 'Filename Parser', sizeMB, relativePath]);
        }
    }

    // 4. Batch Update Sheet
    console.log(`4. Writing ${finalRows.length} unique rows back to Google Sheets...`);
    
    // Clear the entire range to remove ghosts/duplicates
    await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1!A2:K'
    });

    // Write the pristine data
    if (finalRows.length > 0) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: 'Sheet1!A2',
            valueInputOption: 'RAW',
            resource: { values: finalRows }
        });
    }

    console.log("\n=== SYNC COMPLETED SUCCESSFULLY ===");
    console.log(`Total exact books in library: ${finalRows.length}`);
}

syncLibrary();
