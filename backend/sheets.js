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
    const headers = ['Goodreads Check', 'Goodreads ID', 'Title', 'Author', 'Year', 'Rating', 'Number of user rating', 'Cover URL', 'Source', 'File Size', 'Location'];
    
    try {
        const response = await SHEETS.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!A1:K1',
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
            range: 'Sheet1!A2:K',
            auth
        });
        const rows = response.data.values || [];
        return rows.map((row, index) => ({
            rowIndex: index + 2,
            goodreadsCheck: row[0] || 'No',
            goodreadsId: row[1] || '',
            title: row[2] || '',
            author: row[3] || '',
            year: row[4] || '',
            rating: row[5] || '',
            ratingCount: row[6] || '',
            cover: row[7] || '',
            source: row[8] || '',
            size: row[9] || '',
            location: row[10] || ''
        }));
    } catch (error) {
        console.error('[Sheets Get Error]', error.message);
        return [];
    }
}

async function addOrUpdateBook(spreadsheetId, bookData, existingBooks = null) {
    const auth = await getAuthClient();
    const books = existingBooks || await getAllBooks(spreadsheetId);
    const existingIndex = books.findIndex(b => b.location === bookData.location);
    
    const rowValues = [
        bookData.goodreadsCheck || 'No',
        bookData.goodreadsId || '',
        bookData.title || '',
        bookData.author || '',
        bookData.year || '',
        bookData.rating || '',
        bookData.ratingCount || '',
        bookData.cover || '',
        bookData.source || '',
        bookData.size || '',
        bookData.location || ''
    ];

    try {
        if (existingIndex !== -1) {
            const existingBook = books[existingIndex];

            await SHEETS.spreadsheets.values.update({
                spreadsheetId,
                range: `Sheet1!A${existingBook.rowIndex}:K${existingBook.rowIndex}`,
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
    } catch (error) {
        if (error.message.includes('Quota exceeded')) {
            console.warn(`[Sheets Quota Error] Waiting 60s before retrying...`);
            await new Promise(r => setTimeout(r, 60000));
            return addOrUpdateBook(spreadsheetId, bookData, existingBooks);
        }
        throw error;
    }
}

module.exports = { setupHeaders, getAllBooks, addOrUpdateBook };
