const { google } = require('googleapis');
require('dotenv').config();

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

async function getAuthClient() {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
        throw new Error('Missing Google Service Account credentials in .env');
    }

    const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, ''),
        scopes: SCOPES
    });
    return auth;
}

const SHEETS = google.sheets('v4');

async function setupHeaders(spreadsheetId) {
    const auth = await getAuthClient();
    const headers = ['Goodreads Check', 'Goodreads ID', 'Title', 'Author', 'Year', 'Rating', 'Cover URL', 'Source', 'Status', 'Location'];
    
    try {
        const response = await SHEETS.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!A1:J1',
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
            range: 'Sheet1!A2:J',
            auth
        });
        const rows = response.data.values || [];
        return rows.map((row, index) => ({
            rowIndex: index + 2,
            goodreadsCheck: row[0] || 'No',
            goodreadsId: row[1] || '',
            title: row[2],
            author: row[3],
            year: row[4],
            rating: row[5],
            cover: row[6],
            source: row[7],
            status: row[8] || 'auto',
            location: row[9] || ''
        }));
    } catch (error) {
        console.error('[Sheets Get Error]', error.message);
        return [];
    }
}

async function addOrUpdateBook(spreadsheetId, bookData) {
    const auth = await getAuthClient();
    const existingBooks = await getAllBooks(spreadsheetId);
    
    // Use location as unique identifier since fileName is removed from sheet
    const existingIndex = existingBooks.findIndex(b => b.location === bookData.location);
    
    const rowValues = [
        bookData.goodreadsCheck || 'No',
        bookData.goodreadsId || '',
        bookData.title,
        bookData.author,
        bookData.year,
        bookData.rating,
        bookData.cover,
        bookData.source,
        bookData.status || 'auto',
        bookData.location || ''
    ];

    if (existingIndex !== -1) {
        const existingBook = existingBooks[existingIndex];
        if (existingBook.status === 'manual') {
            console.log(`[Sheets] Skipping update for "${bookData.title}" (Manual status)`);
            return;
        }

        await SHEETS.spreadsheets.values.update({
            spreadsheetId,
            range: `Sheet1!A${existingBook.rowIndex}:J${existingBook.rowIndex}`,
            valueInputOption: 'RAW',
            resource: { values: [rowValues] },
            auth
        });
        console.log(`[Sheets] Updated: ${bookData.title}`);
    } else {
        await SHEETS.spreadsheets.values.append({
            spreadsheetId,
            range: 'Sheet1!A1',
            valueInputOption: 'RAW',
            resource: { values: [rowValues] },
            auth
        });
        console.log(`[Sheets] Added: ${bookData.title}`);
    }
}

module.exports = { setupHeaders, getAllBooks, addOrUpdateBook };
