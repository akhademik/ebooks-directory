const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const { google } = require('googleapis');
const { parseFilename } = require('./backend/scanner');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const BOOKS_PATH = process.env.BOOKS_PATH;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SUPPORTED_EXTENSIONS = ['.pdf', '.epub', '.mobi', '.azw', '.azw3'];

async function getAuthClient() {
    return new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, ''),
        scopes: SCOPES
    });
}

// Đệ quy quét thư mục và in ra log để bạn biết nó không bị treo
async function getFiles(dir, fileList = []) {
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const file of files) {
        const res = path.resolve(dir, file.name);
        if (file.isDirectory()) {
            await getFiles(res, fileList);
        } else {
            const ext = path.extname(file.name).toLowerCase();
            if (SUPPORTED_EXTENSIONS.includes(ext)) {
                fileList.push(res);
                if (fileList.length % 500 === 0) {
                    console.log(`[Đang Quét] Đã tìm thấy ${fileList.length} file...`);
                }
            }
        }
    }
    return fileList;
}

async function run() {
    console.log("==========================================");
    console.log("🚀 BẮT ĐẦU ĐỒNG BỘ THƯ VIỆN OFFLINE");
    console.log("==========================================\n");

    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // 1. Tải dữ liệu cũ từ Google Sheets
    console.log("1. Đang tải dữ liệu hiện tại từ Google Sheets...");
    let sheetData = [];
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'Sheet1!A2:K'
        });
        sheetData = res.data.values || [];
    } catch (e) {
        console.error("Lỗi khi kết nối Sheets:", e.message);
        return;
    }

    // Dùng Map với key là đường dẫn được chuẩn hóa (NFC) để xóa hoàn toàn các dòng trùng lặp
    const booksMap = new Map();
    for (const row of sheetData) {
        const loc = (row[10] || '').normalize('NFC');
        if (loc) {
            // Nếu bị trùng, ưu tiên giữ lại dòng đã được lấy dữ liệu (Yes)
            if (!booksMap.has(loc) || (row[0] === 'Yes' && booksMap.get(loc)[0] !== 'Yes')) {
                booksMap.set(loc, row);
            }
        }
    }
    console.log(`-> Hoàn tất. Tìm thấy ${booksMap.size} đầu sách duy nhất (đã lọc các dòng trùng lặp).\n`);

    // 2. Quét thư mục nội bộ
    console.log(`2. Bắt đầu quét thư mục NAS: ${BOOKS_PATH}`);
    const localFiles = await getFiles(BOOKS_PATH);
    console.log(`-> Hoàn tất. Có tổng cộng ${localFiles.length} file ebook hợp lệ trên ổ cứng.\n`);

    // 3. Xử lý dữ liệu (Tính File Size và Merge)
    console.log("3. Bắt đầu tính toán File Size và đồng bộ dữ liệu...");
    let added = 0;
    let updatedSize = 0;

    for (let i = 0; i < localFiles.length; i++) {
        const filePath = localFiles[i];
        const relativePath = path.relative(BOOKS_PATH, filePath);
        const locNormalized = relativePath.normalize('NFC');

        if (i % 500 === 0 && i > 0) {
            console.log(`[Đang Xử Lý] Đã đồng bộ ${i}/${localFiles.length} file...`);
        }

        const existingRow = booksMap.get(locNormalized);
        
        // Kiểm tra xem có cần đo size không
        let sizeMB = '0.00';
        const needsSize = !existingRow || !existingRow[9] || existingRow[9] === 'N/A' || existingRow[9] === '0.00';
        
        if (needsSize) {
            try {
                const stats = await fs.stat(filePath);
                sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            } catch(e) {}
        }

        if (existingRow) {
            // Sách đã có -> Cập nhật size nếu thiếu
            if (needsSize && sizeMB !== '0.00') {
                existingRow[9] = sizeMB;
                updatedSize++;
            }
            existingRow[10] = relativePath; // Đảm bảo đường dẫn chuẩn xác
            booksMap.set(locNormalized, existingRow);
        } else {
            // Sách mới tinh -> Tách tên và tạo dòng mới
            const parsed = parseFilename(path.basename(filePath));
            // Cấu trúc cột: Check, ID, Title, Author, Year, Rating, RatingCount, Cover, Source, Size, Location
            const newRow = ['No', '', parsed.title, parsed.author, 'N/A', 'N/A', '', '', 'Filename Parser', sizeMB, relativePath];
            booksMap.set(locNormalized, newRow);
            added++;
        }
    }

    console.log(`-> Hoàn tất xử lý! Thêm mới: ${added} cuốn | Cập nhật Size: ${updatedSize} cuốn.\n`);

    // 4. Đẩy ngược lên Google Sheets (Ghi đè 1 lần duy nhất)
    console.log("4. Đang dọn dẹp và đẩy toàn bộ dữ liệu sạch lên Google Sheets...");
    const finalRows = Array.from(booksMap.values());

    // Sắp xếp theo đường dẫn cho đẹp
    finalRows.sort((a, b) => (a[10] || '').localeCompare(b[10] || ''));

    // Xóa sạch bảng cũ để diệt tận gốc các file bị đè/trùng lặp
    await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1!A2:K'
    });

    // Đổ dữ liệu mới vào
    if (finalRows.length > 0) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: 'Sheet1!A2',
            valueInputOption: 'RAW',
            resource: { values: finalRows }
        });
    }

    console.log("\n==========================================");
    console.log(`✅ ĐỒNG BỘ THÀNH CÔNG!`);
    console.log(`Tổng số sách chuẩn xác lưu trong Sheets: ${finalRows.length}`);
    console.log("Bạn có thể tắt script này và bật Server chạy bình thường.");
    console.log("==========================================");
}

run();
