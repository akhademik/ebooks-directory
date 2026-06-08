const fs = require('fs');
const path = require('path');
const { parseFilename } = require('../backend/scanner');
require('dotenv').config();

const BOOKS_PATH = process.env.BOOKS_PATH;
const SUPPORTED_EXTENSIONS = ['.pdf', '.epub', '.mobi', '.azw', '.azw3'];

function walkSync(dir, fileList = [], limit = 20) {
    if (!fs.existsSync(dir)) {
        console.error(`\n❌ ERROR: Directory NOT found: ${dir}`);
        return fileList;
    }

    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        if (fileList.length >= limit) break;

        const res = path.resolve(dir, file.name);
        if (file.isDirectory()) {
            walkSync(res, fileList, limit);
        } else {
            if (SUPPORTED_EXTENSIONS.includes(path.extname(file.name).toLowerCase())) {
                fileList.push(res);
            }
        }
    }
    return fileList;
}

async function runDiagnostic() {
    console.log("=== NAS ACCESS & REGEX DIAGNOSTIC ===");
    console.log(`Target Path: ${BOOKS_PATH}\n`);

    const startTime = Date.now();
    const books = walkSync(BOOKS_PATH, [], 20);
    const duration = Date.now() - startTime;

    if (books.length === 0) {
        console.log("❌ No books found or path is inaccessible.");
        console.log("Check if the NAS is mounted and the path in .env is correct.");
        return;
    }

    console.log(`✅ Successfully accessed NAS! Found ${books.length} sample books (Limit: 20).`);
    console.log(`Scan time: ${duration}ms\n`);

    console.log("--- REGEX PARSING RESULTS ---");
    console.log(`${"FILENAME".padEnd(50)} | ${"TITLE".padEnd(30)} | ${"AUTHOR"}`);
    console.log("-".repeat(100));

    books.forEach(filePath => {
        const fileName = path.basename(filePath);
        const parsed = parseFilename(fileName);
        
        console.log(
            `${fileName.substring(0, 47).padEnd(50)} | ` +
            `${parsed.title.substring(0, 27).padEnd(30)} | ` +
            `${parsed.author || 'N/A'}`
        );
    });

    console.log("\n=== DIAGNOSTIC COMPLETED ===");
}

runDiagnostic();
