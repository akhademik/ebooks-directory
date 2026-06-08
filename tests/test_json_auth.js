const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function testJsonAuth() {
    console.log("=== JSON AUTH DIAGNOSTIC ===");
    const jsonPath = path.join(__dirname, '../gen-lang-client-0554245806-18194cdbd937.json');
    
    if (!fs.existsSync(jsonPath)) {
        console.error("❌ ERROR: JSON file not found at", jsonPath);
        return;
    }

    try {
        const credentials = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const auth = google.auth.fromJSON(credentials);
        auth.scopes = ['https://www.googleapis.com/auth/spreadsheets'];

        const sheets = google.sheets({ version: 'v4', auth });

        console.log("Attempting to get spreadsheet metadata using JSON file...");
        const res = await sheets.spreadsheets.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
        });
        console.log("✅ SUCCESS! Connected to Sheet:", res.data.properties.title);
    } catch (err) {
        console.error("❌ JSON AUTH FAILED:");
        if (err.response && err.response.data) {
            console.error(JSON.stringify(err.response.data, null, 2));
        } else {
            console.error(err.message);
        }
    }
}

testJsonAuth();
