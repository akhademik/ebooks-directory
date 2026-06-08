const { getBookMetadata } = require('../backend/scanner');

const testFiles = [
    "The Great Gatsby - F. Scott Fitzgerald.pdf",
    "Clean_Code.Robert.C.Martin.epub",
    "Unknown Book Title.mobi",
    "[PDF] Harry Potter (J.K. Rowling).pdf",
    "NonExistentBook12345ThatWillFailAPI.pdf"
];

async function runTests() {
    console.log("=== STARTING SCANNER TESTS ===\n");
    
    for (const filename of testFiles) {
        console.log(`Testing file: "${filename}"`);
        try {
            const metadata = await getBookMetadata(filename);
            console.log("Result:", JSON.stringify(metadata, null, 2));
            console.log("------------------------------\n");
        } catch (err) {
            console.error(`FAILED for ${filename}:`, err.message);
        }
    }

    console.log("=== TESTS COMPLETED ===");
}

runTests();
