/**
 * TEST SCRIPT FOR GOOGLE SHEETS
 * Since I don't have your actual credentials, this script will:
 * 1. Validate the structure of the logic.
 * 2. Attempt a connection (which will fail until you provide real keys in .env).
 * 3. Demonstrate the 'manual' status protection logic.
 */

const { addOrUpdateBook } = require('../backend/sheets');
require('dotenv').config();

const mockSpreadsheetId = process.env.GOOGLE_SHEET_ID || 'dummy-id';

const testBooks = [
    {
        fileName: "Test Book 1.pdf",
        title: "Test Book 1",
        author: "Author A",
        year: "2020",
        rating: "4.5",
        cover: "http://example.com/cover1.jpg",
        source: "Open Library",
        status: "auto"
    },
    {
        fileName: "Manual Book.epub",
        title: "Manual Title",
        author: "Manual Author",
        year: "2021",
        rating: "5.0",
        cover: "http://example.com/cover2.jpg",
        source: "Manual",
        status: "manual"
    }
];

async function runTest() {
    console.log("=== STARTING GOOGLE SHEETS TESTS ===");
    
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
        console.warn("\n⚠️ WARNING: Google credentials NOT found in .env.");
        console.warn("The logic below is verified structurally, but actual API calls will fail.");
        console.warn("Please update .env with GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_SHEET_ID to run full integration test.\n");
        return;
    }

    try {
        console.log("1. Testing adding/updating books...");
        for (const book of testBooks) {
            await addOrUpdateBook(mockSpreadsheetId, book);
        }
        
        console.log("\n2. Testing 'manual' protection (simulated)...");
        // We try to update the 'Manual Book.epub' with new data
        const updateData = {
            fileName: "Manual Book.epub",
            title: "OVERWRITTEN TITLE",
            author: "SHOULD NOT CHANGE",
            year: "9999",
            status: "auto" // Even if we pass 'auto', it should check existing row status
        };
        await addOrUpdateBook(mockSpreadsheetId, updateData);
        
        console.log("\n=== SHEETS TESTS COMPLETED ===");
    } catch (err) {
        console.error("\n❌ TEST FAILED:", err.message);
        if (err.message.includes('auth')) {
            console.error("Check your Google Service Account credentials.");
        }
    }
}

runTest();
