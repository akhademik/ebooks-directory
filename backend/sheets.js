const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

async function getAuthClient() {
    // Ưu tiên dùng file JSON vì nó ổn định hơn .env
    const jsonPath = path.join(__dirname, '../gen-lang-client-0554245806-18194cdbd937.json');
    
    if (fs.existsSync(jsonPath)) {
        const credentials = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const auth = google.auth.fromJSON(credentials);
        auth.scopes = SCOPES;
        return auth;
    }

    // Fallback sang .env nếu không có file JSON
    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '') : undefined,
        SCOPES
    );
    return auth;
}

const SHEETS = google.sheets('v4');

async function setupHeaders(spreadsheetId) {
    const auth = await getAuthClient();
    const headers = ['File Name', 'Title', 'Author', 'Year', 'Rating', 'Cover URL', 'Source', 'Status'];
    
    try {
        const response = await SHEETS.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!A1:H1',
            auth
        });

        if (!response.data.values || response.data.values[0].length === 0) {
            await SHEETS.spreadsheets.values.update({
                spreadsheetId,
                range: 'Sheet1!A1',
                valueInputOption: 'RAW',
                resource: { values: [headers] },
                auth
            });
            console.log('[Sheets] Headers created.');
        }
    } catch (error) {
        console.error('[Sheets Setup Error]', error.message);
    }
}

async function getAllBooks(spreadsheetId) {
    const auth = await getAuthClient();
    try {
        const response = await SHEETS.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!A2:H',
            auth
        });
        const rows = response.data.values || [];
        return rows.map((row, index) => ({
            rowIndex: index + 2,
            fileName: row[0],
            title: row[1],
            author: row[2],
            year: row[3],
            rating: row[4],
            cover: row[5],
            source: row[6],
            status: row[7] || 'auto'
        }));
    } catch (error) {
        console.error('[Sheets Get Error]', error.message);
        return [];
    }
}

async function addOrUpdateBook(spreadsheetId, bookData) {
    const auth = await getAuthClient();
    const existingBooks = await getAllBooks(spreadsheetId);
    
    const existingIndex = existingBooks.findIndex(b => b.fileName === bookData.fileName);
    
    const rowValues = [
        bookData.fileName,
        bookData.title,
        bookData.author,
        bookData.year,
        bookData.rating,
        bookData.cover,
        bookData.source,
        bookData.status || 'auto'
    ];

    if (existingIndex !== -1) {
        const existingBook = existingBooks[existingIndex];
        if (existingBook.status === 'manual') {
            console.log(`[Sheets] Skipping update for "${bookData.fileName}" (Manual status)`);
            return;
        }

        await SHEETS.spreadsheets.values.update({
            spreadsheetId,
            range: `Sheet1!A${existingBook.rowIndex}:H${existingBook.rowIndex}`,
            valueInputOption: 'RAW',
            resource: { values: [rowValues] },
            auth
        });
        console.log(`[Sheets] Updated: ${bookData.fileName}`);
    } else {
        await SHEETS.spreadsheets.values.append({
            spreadsheetId,
            range: 'Sheet1!A1',
            valueInputOption: 'RAW',
            resource: { values: [rowValues] },
            auth
        });
        console.log(`[Sheets] Added: ${bookData.fileName}`);
    }
}

module.exports = { setupHeaders, getAllBooks, addOrUpdateBook };
