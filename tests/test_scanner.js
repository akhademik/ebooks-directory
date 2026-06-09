const { getBookMetadata } = require('../backend/scanner');
const path = require('path');
const fs = require('fs');

const testFiles = [
    "The Great Gatsby - F. Scott Fitzgerald.pdf",
    "Clean_Code.Robert.C.Martin.epub",
    "Unknown Book Title.mobi",
    "[PDF] Harry Potter (J.K. Rowling).pdf",
    "NonExistentBook12345ThatWillFailAPI.pdf"
];

const DUMMY_COVERS = path.join(__dirname, 'dummy_covers');
if (!fs.existsSync(DUMMY_COVERS)) fs.mkdirSync(DUMMY_COVERS);

async function runTests() {
    console.log("=== STARTING SCANNER TESTS ===\n");
    
    for (const filename of testFiles) {
        console.log(`Testing file: "${filename}"`);
        try {
            // Mocking absolute path as the filename itself for testing purposes
            const metadata = await getBookMetadata(filename, filename, filename, DUMMY_COVERS);
            console.log("Result:", JSON.stringify(metadata, null, 2));
            console.log("------------------------------\n");
        } catch (err) {
            console.error(`FAILED for ${filename}:`, err.message);
        }
    }

    console.log("=== TESTS COMPLETED ===");
}

runTests();
