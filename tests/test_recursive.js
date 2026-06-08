const fs = require('fs');
const path = require('path');

// Mock recursive walk function from server.js for testing
function walkSync(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const res = path.resolve(dir, file.name);
        if (file.isDirectory()) {
            walkSync(res, fileList);
        } else {
            if (['.pdf', '.epub', '.mobi'].includes(path.extname(file.name).toLowerCase())) {
                fileList.push(res);
            }
        }
    }
    return fileList;
}

async function runTest() {
    console.log("=== STARTING RECURSIVE SCANNER TEST ===");
    
    // Create a temporary structure for testing
    const testDir = path.join(__dirname, 'mock_books');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    
    fs.mkdirSync(path.join(testDir, 'Level1/Level2'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'book1.pdf'), 'dummy');
    fs.writeFileSync(path.join(testDir, 'Level1/book2.epub'), 'dummy');
    fs.writeFileSync(path.join(testDir, 'Level1/Level2/book3.mobi'), 'dummy');
    fs.writeFileSync(path.join(testDir, 'not_a_book.txt'), 'dummy');

    console.log(`Scanning mock directory: ${testDir}`);
    const results = walkSync(testDir);
    
    console.log("Found files:", results.map(f => path.relative(testDir, f)));
    
    const expectedCount = 3;
    if (results.length === expectedCount) {
        console.log(`✅ SUCCESS: Found exactly ${expectedCount} books.`);
    } else {
        console.error(`❌ FAILED: Expected ${expectedCount} but found ${results.length}`);
    }

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
}

runTest();
