const fs = require('fs').promises;
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const BOOKS_PATH = process.env.BOOKS_PATH;

async function test() {
    const loc = "HUYỀN ẢO-KỲ BÍ/THANH PHO HON RONG - Ransom Riggs.epub";
    const abs = path.resolve(BOOKS_PATH, loc);
    console.log("Checking:", abs);
    try {
        const stats = await fs.stat(abs);
        console.log("Size:", stats.size);
    } catch(e) {
        console.error(e.message);
    }
}
test();
