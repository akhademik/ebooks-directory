const { google } = require('googleapis');
require('dotenv').config();

async function testAuth() {
    console.log("=== GOOGLE AUTH DIAGNOSTIC ===");
    console.log("Email:", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
    console.log("Sheet ID:", process.env.GOOGLE_SHEET_ID);
    
    const privateKey = process.env.GOOGLE_PRIVATE_KEY 
        ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '') 
        : null;

    if (!privateKey) {
        console.error("❌ ERROR: Private Key is missing in .env");
        return;
    }

    const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        privateKey,
        ['https://www.googleapis.com/auth/spreadsheets']
    );

    const sheets = google.sheets({ version: 'v4', auth });

    try {
        console.log("Attempting to get spreadsheet metadata...");
        const res = await sheets.spreadsheets.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
        });
        console.log("✅ SUCCESS! Connected to Sheet:", res.data.properties.title);
    } catch (err) {
        console.error("❌ AUTH FAILED:");
        if (err.response && err.response.data) {
            console.error(JSON.stringify(err.response.data, null, 2));
        } else {
            console.error(err.message);
        }
        
        console.log("\n--- TROUBLESHOOTING TIPS ---");
        console.log("1. Ensure GOOGLE_SHEET_ID is correct (the long string in the URL).");
        console.log("2. Ensure the Service Account Email is shared as 'Editor' on the sheet.");
        console.log("3. Ensure 'Google Sheets API' is ENABLED in Google Cloud Console.");
    }
}

testAuth();
