# Ebook Manager — Improvement Tasklist

> Thứ tự thực hiện: Task 0 → Fix 1 → Fix 2 → Fix 3  
> Mỗi task phải hoàn thành và test trước khi sang task tiếp theo.

---

## Context & Architecture hiện tại

- **NAS**: Nguồn lưu file ebook thực tế
- **Backend**: Node.js/Express, có `cachedBooks` là biến in-memory
- **Google Sheets**: 11 cột, human editing interface, nơi user sửa tay title/goodreads ID/tags
- **Goodreads Workers**: 3 workers song song, scrape metadata, hiện ghi thẳng lên Sheets
- **Frontend**: Vanilla JS, gọi `/api/books` từ backend

**Vấn đề cần giải quyết:**

1. Không có local cache — restart server là fetch lại Sheets từ đầu
2. 3 workers ghi Sheets đồng thời → dễ hit rate limit, race condition
3. Sheets đang bị dùng như database thay vì human interface
4. Chưa có duplicate detection

---

## TASK 0 — Local JSON Cache (làm trước tất cả)

> Mục tiêu: Tạo cache layer giữa Sheets và backend, tránh fetch Sheets mỗi khi restart.

### TASK 0.1 — Tạo thư mục và file cache

- Tạo thư mục `backend/storage/`
- Tạo file `backend/storage/books.cache.json` với nội dung ban đầu là `[]`
- Thêm vào `.gitignore`:
  ```
  backend/storage/books.cache.json
  ```

### TASK 0.2 — Tạo cacheManager module

- Tạo file `backend/services/cacheManager.service.js`
- Expose các method:
  - `load()` → đọc `books.cache.json`, trả về array books (hoặc `[]` nếu file không tồn tại)
  - `save(books)` → ghi toàn bộ array `cachedBooks` ra `books.cache.json`
  - `updateOne(location, fields)` → tìm book theo `location`, merge `fields` vào, rồi gọi `save()`

### TASK 0.3 — Tích hợp vào startup flow

Khi server start, thứ tự ưu tiên như sau:

1. Gọi `cacheManager.load()` — nếu có data → dùng làm `cachedBooks`, **không gọi Sheets**
2. Nếu cache rỗng hoặc file không tồn tại → fetch từ Sheets như hiện tại
3. Sau khi fetch từ Sheets xong → gọi `cacheManager.save(cachedBooks)` để tạo cache

> **Lưu ý Docker**: Nếu container restart và `books.cache.json` bị mất, flow sẽ tự động fallback về fetch Sheets → tạo lại cache. Không mất data, chỉ tốn thêm 1 lần gọi Sheets API lúc startup.

### TASK 0.4 — Các thời điểm save cache

- Sau mỗi lần `writeQueue` flush thành công (xem Fix 1)
- Sau mỗi lần scanner sync xong
- **Không** save sau mỗi worker update đơn lẻ (tránh I/O liên tục)

---

## FIX 1 — Write Queue cho Goodreads Workers

> Mục tiêu: Tránh Sheets API rate limit (60 req/min), tránh concurrent write conflict từ 3 workers.

### TASK 1.1 — Tạo writeQueue module

- Tạo file `backend/services/writeQueue.service.js`
- Queue là một array in-memory
- Expose các method:
  - `enqueue(bookData)` → thêm 1 record vào queue
  - `flush()` → gom tất cả items trong queue thành 1 Sheets API batch update, rồi clear queue
- `flush()` chạy theo interval: **mỗi 10 giây**
- Nếu Sheets API fail → **giữ lại items trong queue**, retry lần `flush()` tiếp theo (không mất data)

### TASK 1.2 — Refactor enrichmentService.js

- Thay thế tất cả chỗ gọi `saveBook()` trực tiếp → `writeQueue.enqueue(bookData)`
- Workers **không còn ghi Sheets trực tiếp** nữa
- Workers **vẫn update `cachedBooks` ngay lập tức** sau khi scrape xong (giữ nguyên jitter-free UI)

### TASK 1.3 — Graceful shutdown

- Khi server nhận `SIGTERM` hoặc `SIGINT` → gọi `writeQueue.flush()` trước khi tắt
- Đảm bảo không mất data khi restart Docker container

---

## FIX 2 — Sheets là "source of edits", không phải "source of truth"

> Mục tiêu: Giảm phụ thuộc vào Sheets API, app vẫn chạy khi Sheets API down.

### TASK 2.1 — Chỉ đọc Sheets khi cần thiết

- Đọc Sheets khi: **server startup** (nếu cache rỗng) và khi user trigger **"Sync Library"**
- `/api/books` chỉ trả về `cachedBooks` — không bao giờ gọi Sheets API trực tiếp
- Nếu Sheets API down → app vẫn chạy bình thường từ cache

### TASK 2.2 — Tách biệt sync direction rõ ràng

| Direction              | Khi nào                               | Ghi chú        |
| ---------------------- | ------------------------------------- | -------------- |
| NAS → `cachedBooks`    | Scanner chạy                          | Luôn ưu tiên   |
| Sheets → `cachedBooks` | Startup (cache rỗng) hoặc manual sync | Fallback       |
| `cachedBooks` → Sheets | Async, qua `writeQueue`               | Không block UI |

### TASK 2.3 — Conflict resolution khi sync từ Sheets về

Khi đọc Sheets về và merge vào `cachedBooks`, áp dụng rule sau:

- **Ưu tiên giữ giá trị từ Sheets** (user đã edit tay):
  - `Title`, `Author`, `Goodreads ID`, `Goodreads Check`
- **Ưu tiên giữ giá trị từ filesystem** (luôn thắng):
  - `Location`, `File Size`, `Extension`

---

## FIX 3 — Duplicate Detection + UI Tab

> Mục tiêu: Phát hiện duplicate theo 4 tầng, hiển thị tab riêng, cho phép delete file trực tiếp.

### TASK 3.1 — Thêm cột "File Hash" vào Sheets

- Thêm cột thứ 12: `File Hash` vào Google Sheet
- Cập nhật code mapping cột ở backend để nhận biết cột mới này

### TASK 3.2 — Tạo duplicate detector module

- Tạo file `backend/services/duplicateDetector.service.js`
- Chạy detection trên `cachedBooks` hiện có (không scan lại NAS)
- Trả về kết quả nhóm theo 4 tầng confidence

### TASK 3.3 — Implement 4 tầng detection

**Tầng 1 — SHA256 Hash → `confirmed` 🔴**

- Hash file content bằng `crypto.createHash('sha256')`
- Đọc file bằng stream, không load toàn bộ vào memory
- Nếu book đã có `File Hash` trong cache → dùng lại, không hash lại
- Nếu chưa có → hash và `enqueue` update cột `File Hash` lên Sheets (qua writeQueue)
- Group các file có hash giống nhau → `confirmed duplicate`

**Tầng 2 — File Size + Extension → `probable` 🟡**

- Group theo: `fileSize (bytes)` + `extension` giống nhau
- Loại trừ các cặp đã được xác nhận ở Tầng 1

**Tầng 3 — Goodreads ID → `probable` 🟡**

- Group các file có cùng `Goodreads ID`
- Chỉ áp dụng khi `Goodreads Check = "Yes"`
- Loại trừ các cặp đã có ở Tầng 1

**Tầng 4 — Normalized Filename → `possible` 🟠**

- Dùng tên file gốc từ cột `Location` (không dùng `Title` từ Goodreads)
- Normalize: lowercase, bỏ extension, bỏ special chars và spaces
- Ví dụ: `Clean.Code-Robert.Martin.pdf` → `cleancoderobertmartin`
- Group các file có normalized filename giống nhau
- Loại trừ các cặp đã có ở Tầng 1, 2, 3

### TASK 3.4 — Background hash worker

- Hash worker chạy **sau khi** Goodreads enrichment queue trống
- Chỉ chạy **1 hash worker** tại một thời điểm (tránh làm nặng NAS I/O)
- Hash worker có priority thấp hơn Goodreads workers

### TASK 3.5 — API endpoint

- Thêm `GET /api/duplicates`
- Response format:

```json
{
  "confirmed": [
    {
      "key": "sha256_hash_value",
      "confidence": "confirmed",
      "files": [
        { "path": "/books/a.pdf", "size": 5242880, "ext": "pdf" },
        { "path": "/books/b.pdf", "size": 5242880, "ext": "pdf" }
      ]
    }
  ],
  "probable": [...],
  "possible": [...],
  "stats": {
    "totalGroups": 12,
    "totalWastedBytes": 52428800,
    "totalWastedFormatted": "50 MB"
  }
}
```

### TASK 3.6 — UI: Tab Duplicates

- Thêm tab **"⚠️ Duplicates"** vào navigation (cạnh All Books, Search)
- Badge hiển thị tổng số group trên tab
- Hiển thị stat tổng dung lượng có thể giải phóng
- Layout mỗi duplicate group:

```
[Confidence Badge] Group Key                    X files — Wasted: Y MB
├── /books/clean-code-1.pdf    |  5.2 MB  |  PDF    [🗑 Delete]
├── /books/clean-code-2.pdf    |  5.1 MB  |  PDF    [🗑 Delete]
└── /books/clean-code-3.epub   |  2.3 MB  |  EPUB   [🗑 Delete]
```

- Confidence badge: `🔴 Confirmed` / `🟡 Probable` / `🟠 Possible`
- Các group `Confirmed` hiển thị trước, sau đó `Probable`, cuối cùng `Possible`

### TASK 3.7 — Delete functionality

- Thêm endpoint `DELETE /api/books/file`
- Request body: `{ "location": "/books/path/to/file.pdf" }`
- Backend thực hiện theo thứ tự:
  1. Xác nhận file tồn tại trên NAS (`fs.existsSync`)
  2. Xóa file (`fs.unlink`)
  3. Xóa record khỏi `cachedBooks`
  4. Enqueue xóa row khỏi Sheets (qua `writeQueue`)
  5. Gọi `cacheManager.save()` để cập nhật JSON cache
- UI thực hiện theo thứ tự:
  1. Hiện confirm dialog: _"Xóa vĩnh viễn file [tên file]? Hành động này không thể hoàn tác."_
  2. Sau khi delete thành công → xóa file row khỏi group
  3. Nếu group chỉ còn 1 file → xóa luôn group đó khỏi UI
  4. Cập nhật lại badge count và stats

---

## Thứ tự thực hiện tổng thể

```
Task 0 (JSON Cache)
    └─→ Fix 1 (Write Queue)
            └─→ Fix 2 (Sheets as edits only)
                    └─→ Fix 3 (Duplicate Detection + UI)
```

---

## Files mới cần tạo

```
backend/
  storage/
    books.cache.json          ← tạo mới, thêm vào .gitignore
  services/
    cacheManager.service.js   ← tạo mới
    writeQueue.service.js     ← tạo mới
    duplicateDetector.service.js  ← tạo mới
```

## Files cần chỉnh sửa

```
backend/
  server.js                   ← Task 0.3, Task 1.3, Task 2.1
  services/
    enrichmentService.js      ← Task 1.2
frontend/
  app.js (hoặc tương đương)   ← Task 3.6, Task 3.7
```
