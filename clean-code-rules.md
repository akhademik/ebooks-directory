# Clean Code Rules — ebooks-directory
> Dành cho AI assistant (Claude Code, Cursor, Copilot, v.v.) khi refactor project này.
> Stack: Node.js / Express (backend) + Vanilla JavaScript (frontend) + ESLint đã cấu hình sẵn.

---

## ⚙️ QUY TRÌNH BẮT BUỘC SAU MỖI THAY ĐỔI

**Trước khi thông báo "đã xong" bất kỳ task nào, AI phải chạy tuần tự:**

```bash
# Bước 1 – Lint toàn bộ project
npm run lint

# Bước 2 – Nếu có lỗi auto-fixable, fix trước
npm run lint -- --fix

# Bước 3 – Chạy lại lint lần cuối để xác nhận sạch
npm run lint

# Bước 4 – Chạy test nếu có
npm test
```

> Chỉ báo cáo hoàn thành khi **0 lỗi ESLint**. Nếu còn warning, liệt kê rõ ràng.

---

## 1. ĐẶT TÊN (Meaningful Names)

### Quy tắc
- **Tên phải tự giải thích** — đọc tên xong phải hiểu: nó là gì, làm gì, dùng khi nào.
- **Không dùng viết tắt** trừ các từ cực kỳ phổ biến (`req`, `res`, `err`, `id`, `url`).
- **Nhất quán toàn project** — chọn một từ cho một khái niệm và dùng xuyên suốt.
- **Boolean phải có prefix** `is`, `has`, `can`, `should`.

### Ví dụ cụ thể cho project này

| ❌ Tránh | ✅ Dùng |
|---|---|
| `d`, `tmp`, `val` | `elapsedDays`, `tempFilePath`, `bookTitle` |
| `getData()` | `fetchBooksFromSheet()` |
| `process()` | `enrichBookMetadata()` |
| `check()` | `isValidGoodreadsId()` |
| `flag`, `status` | `isSyncing`, `hasMetadata` |
| `list` (nếu không phải Array/List) | `books`, `pendingBooks` |
| `getBooks()` vs `fetchBooks()` vs `retrieveBooks()` | Chọn **một** — ưu tiên `getBooks()` cho cache/local, `fetchBooks()` cho I/O |

---

## 2. HÀM (Clean Functions)

### Quy tắc
- **Một hàm = một việc duy nhất.** Nếu có thể đặt tên hàm với từ "và" thì đó là dấu hiệu nên tách ra.
- **Tối đa 20 dòng** cho hàm thông thường. Trên 30 dòng phải có lý do đặc biệt.
- **Tối đa 2 tham số.** Từ 3 trở lên → gom vào object có tên rõ ràng.
- **Không side effect ẩn** — hàm tên là `validateBook` không được đồng thời ghi log hay mutate data bên ngoài.
- **Command Query Separation** — hàm hoặc thay đổi state, hoặc trả về giá trị, không làm cả hai.
- **Early return** thay vì if lồng nhau.
- **Async nhất quán** — dùng `async/await` hoàn toàn, không trộn với `.then()/.catch()` trong cùng một function.

### Ví dụ

```js
// ❌ Sai – làm nhiều việc, tham số rời rạc
async function processBook(title, author, id, sheet, scraper) {
  const data = await scraper.scrape(id);
  sheet.update(title, author, data);
  console.log('done');
  return data;
}

// ✅ Đúng – tách rõ ràng
async function scrapeBookMetadata({ goodreadsId }) {
  return await goodreadsScraper.fetchMetadata(goodreadsId);
}

async function updateBookInSheet({ book, metadata, sheetClient }) {
  await sheetClient.updateRow(book.rowIndex, metadata);
}
```

---

## 3. CHÚ THÍCH & ĐỊNH DẠNG

### Quy tắc
- **Không chú thích để giải thích code xấu** — thay vào đó hãy đặt tên tốt hơn hoặc tách hàm.
- **Chú thích chỉ dùng cho:** lý do tại sao (why), cảnh báo side effect, TODO có issue tracking.
- **Giới hạn dòng: 100 ký tự** (phù hợp hơn cho JS hiện đại).
- **Các hàm liên quan đặt gần nhau** theo chiều dọc — hàm gọi đặt trên hàm được gọi.
- **Tách khối logic bằng dòng trống** — không nhồi nhét.

```js
// ❌ Chú thích thừa
// Lấy danh sách sách từ sheet
const books = await getBooks();

// ✅ Chú thích có giá trị
// Goodreads chặn bot theo User-Agent, cần rotate để tránh bị block
const headers = buildStealthHeaders();
```

---

## 4. XỬ LÝ LỖI (Error Handling)

### Quy tắc
- **Dùng `try/catch`** thay vì trả về error codes hay `null` im lặng.
- **Không catch rồi bỏ qua** — ít nhất phải log lỗi với đủ context.
- **Tách error handling khỏi business logic** — không để try/catch ôm toàn bộ hàm.
- **Lỗi phải có message rõ ràng** — bao gồm context (tên hàm, input gây lỗi).

```js
// ❌ Sai
async function syncBooks() {
  try {
    // 50 dòng logic ở đây
  } catch (e) {
    console.log(e);
  }
}

// ✅ Đúng – tách logic và error handler
async function syncBooks() {
  const files = await scanLocalFiles();
  const sheetBooks = await fetchBooksFromSheet();
  const diff = computeSyncDiff({ files, sheetBooks });
  await applyDiffToSheet(diff);
}

// Mỗi hàm nhỏ tự handle lỗi của nó hoặc để throw lên
async function fetchBooksFromSheet() {
  try {
    return await sheetClient.getRows();
  } catch (error) {
    throw new Error(`fetchBooksFromSheet failed: ${error.message}`);
  }
}
```

---

## 5. KHÔNG LẶP LẠI (DRY)

### Quy tắc
- **Cùng logic xuất hiện 2+ lần** → tách thành hàm hoặc module dùng chung.
- **Magic numbers/strings** → khai báo constant có tên.
- **Không copy-paste** code giữa các route handler — dùng middleware hoặc helper.

```js
// ❌ Magic values
if (file.size > 52428800) { ... }
if (ext === 'pdf' || ext === 'epub' || ext === 'mobi') { ... }

// ✅ Named constants
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const SUPPORTED_EBOOK_FORMATS = ['pdf', 'epub', 'mobi', 'azw', 'azw3'];

if (file.size > MAX_FILE_SIZE_BYTES) { ... }
if (SUPPORTED_EBOOK_FORMATS.includes(ext)) { ... }
```

---

## 6. CẤU TRÚC MODULE (áp dụng cho project này)

### Phân chia trách nhiệm đề xuất

```
backend/
├── routes/          # Chỉ định nghĩa routes, không có logic
├── controllers/     # Điều phối request/response, gọi services
├── services/        # Business logic thuần túy (sync, scrape, metadata)
├── clients/         # Tương tác external (Google Sheets, Goodreads)
└── utils/           # Hàm tiện ích thuần, không có side effect
```

### Quy tắc module
- **Route file** chỉ chứa `router.get/post/...` và gọi controller.
- **Controller** không chứa business logic — chỉ validate input, gọi service, format response.
- **Service** không biết gì về HTTP (`req`, `res`) — chỉ nhận/trả plain data.

---

## 7. ASYNC & JAVASCRIPT ĐẶC THÙ

- **Luôn dùng `async/await`** — không trộn với `.then()/.catch()` cùng cấp.
- **Xử lý promise song song** khi không phụ thuộc nhau: dùng `Promise.all()`.
- **Không dùng `var`** — chỉ dùng `const` (ưu tiên) và `let`.
- **Destructuring** cho tham số object để tên tự document.
- **Arrow function** cho callback ngắn, `function` keyword cho hàm có tên ở module level.

---

## 8. CHECKLIST TRƯỚC KHI BÁO CÁO HOÀN THÀNH

AI phải tự kiểm tra từng mục trước khi nói "done":

- [ ] `npm run lint` chạy ra **0 errors**
- [ ] Không có hàm nào dài hơn 30 dòng mà không có lý do
- [ ] Không có tham số hàm nào nhiều hơn 3 mà chưa gom thành object
- [ ] Không có magic number hay magic string nào còn sót
- [ ] Không có đoạn code nào bị lặp lại (copy-paste)
- [ ] Mọi `catch` block đều có xử lý thực sự (không bỏ trống hoặc chỉ `console.log`)
- [ ] Không có biến tên một chữ cái (trừ loop index `i`, `j` hoặc destructuring)
- [ ] Các hàm async đều dùng `async/await`, không trộn `.then()`

---

## 📋 PROMPT MẪU — Dùng khi giao task cho AI

```
Refactor file [tên file] theo các rules trong clean-code-rules.md:

1. Đặt tên: biến/hàm phải tự giải thích ý định
2. Hàm: tối đa 20 dòng, tối đa 2 tham số, chỉ làm một việc
3. DRY: tách mọi logic lặp lại
4. Error handling: dùng try/catch có message rõ ràng
5. Async: nhất quán async/await

Sau khi refactor, PHẢI chạy:
  npm run lint
  npm run lint -- --fix  (nếu có lỗi fixable)
  npm run lint           (lần cuối xác nhận sạch)

Chỉ báo cáo xong khi lint ra 0 errors. Nếu còn warnings, liệt kê rõ.
```
