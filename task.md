# FIX 3 — Duplicate Detection + UI Tab

> Mục tiêu: Phát hiện duplicate theo 4 tầng, hiển thị tab riêng, gợi ý file nên giữ, cho phép delete.

---

## Context quan trọng

- Sách chủ yếu là **sách Việt Nam, tự scan** → không có ISBN
- Tên file có thể có dấu tiếng Việt hoặc không dấu cho cùng 1 cuốn
- Chỉ muốn giữ **1 bản duy nhất** mỗi cuốn
- Sách scan dạng PDF: **size lớn hơn = chất lượng tốt hơn**
- Sách dạng EPUB/AZW/AZW3/MOBI: **size nhỏ hơn = được optimize tốt hơn**

---

## TASK 3.1 — Dependency: Thư viện xử lý tiếng Việt

- Cài thêm package `unidecode` (hoặc implement thủ công bảng map dấu → không dấu)
- Dùng để normalize tên file tiếng Việt trước khi so sánh
- Ví dụ: `"Đắc Nhân Tâm"` → `"dac nhan tam"`

---

## TASK 3.2 — Tạo duplicate detector module

- Tạo file `backend/services/duplicateDetector.service.js`
- Chạy detection trên `cachedBooks` hiện có, không scan lại NAS
- Trả về kết quả đã gom nhóm theo 4 tầng confidence

---

## TASK 3.3 — Implement 4 tầng detection

### Tầng 1 — SHA256 Hash → `confirmed` 🔴

- Hash file content bằng `crypto.createHash('sha256')`
- Đọc file bằng stream, không load toàn bộ vào memory
- Nếu book đã có `File Hash` trong cache → dùng lại, không hash lại
- Nếu chưa có → hash và `enqueue` update cột `File Hash` lên Sheets (qua writeQueue)
- Group các file có hash giống nhau → `confirmed duplicate`

### Tầng 2 — Fuzzy Title Match (có xử lý tiếng Việt) → `probable` 🟡

Đây là tầng quan trọng nhất với sách Việt:

**Bước normalize tên file:**

```
Input:  "Đắc Nhân Tâm - Dale Carnegie (scan).pdf"
Bước 1: Bỏ extension          → "Đắc Nhân Tâm - Dale Carnegie (scan)"
Bước 2: Bỏ dấu tiếng Việt     → "Dac Nhan Tam - Dale Carnegie (scan)"
Bước 3: Lowercase              → "dac nhan tam - dale carnegie (scan)"
Bước 4: Bỏ các suffix phổ biến → bỏ "(scan)", "(1)", "_copy", "_v2", "-final", "_3"...
Bước 5: Bỏ special chars       → "dac nhan tam dale carnegie"
Bước 6: Trim whitespace        → "dac nhan tam dale carnegie"
```

**Ví dụ các case cần bắt được:**

```
"Đắc Nhân Tâm - Dale Carnegie.pdf"     → "dac nhan tam dale carnegie"
"dac_nhan_tam_dale_carnegie.epub"       → "dac nhan tam dale carnegie"  ✓ match
"Đắc Nhân Tâm (scan).pdf"              → "dac nhan tam"                 ✓ partial match
"Đắc Nhân Tâm_3.epub"                  → "dac nhan tam"                 ✓ partial match
```

**Thuật toán so sánh:**

- Dùng Dice Coefficient similarity
- Ngưỡng match: **≥ 70%**
- Group các file vượt ngưỡng → `probable duplicate`
- Loại trừ các cặp đã có ở Tầng 1

### Tầng 3 — Goodreads ID → `probable` 🟡

- Group các file có cùng `Goodreads ID`
- Chỉ áp dụng khi `Goodreads Check = "Yes"` (đã được confirm)
- Lưu ý: coverage Goodreads cho sách Việt thấp, tầng này sẽ ít match hơn
- Loại trừ các cặp đã có ở Tầng 1

### Tầng 4 — Same Format + Size Range ±10% → `possible` 🟠

- Group theo: cùng `extension` + file size chênh lệch ≤ 10%
- Mục tiêu: bắt case scan lại cùng cuốn với setting khác (DPI khác, quality khác)
- Ví dụ: `abc.pdf` 5.2MB và `abc.pdf` 5.5MB → size chênh 5.7% → possible duplicate
- Loại trừ các cặp đã có ở Tầng 1, 2, 3

---

## TASK 3.4 — Background hash worker

- Hash worker chạy **sau khi** Goodreads enrichment queue trống
- Chỉ chạy **1 hash worker** tại một thời điểm (tránh làm nặng NAS I/O)
- Hash worker có priority thấp hơn Goodreads workers

---

## TASK 3.5 — Recommendation Engine ("nên giữ bản nào")

Với mỗi duplicate group, tự động highlight 1 file là `recommended` để giữ lại:

```
Bước 1 — Xét theo format nếu group có nhiều format khác nhau:
  - Ưu tiên: EPUB > AZW3 > AZW > MOBI > PDF
  - Lý do: EPUB/AZW là text-based, đọc được trên mọi thiết bị

Bước 2 — Nếu group toàn cùng format, xét theo size:
  - PDF      → giữ file SIZE LỚN NHẤT (scan độ phân giải cao hơn)
  - EPUB / AZW / AZW3 / MOBI → giữ file SIZE NHỎ NHẤT (đã được optimize)

Bước 3 — Nếu vẫn tie, xét theo tên file:
  - Ưu tiên file có tên "sạch" hơn
  - Loại bỏ ưu tiên nếu tên chứa: "(1)", "_copy", "_scan", "_v2", "-final", "(2)"...

Bước 4 — Nếu vẫn tie:
  - Giữ file có modified date MỚI HƠN
```

UI hiển thị file được recommend với badge `⭐ Recommended` và các file còn lại có nút `🗑 Delete`.

---

## TASK 3.6 — Thêm cột "File Hash" vào Sheets

- Thêm cột thứ 12: `File Hash` vào Google Sheet
- Cập nhật code mapping cột ở backend để nhận biết cột mới này
- Khi hash xong → enqueue update cột này lên Sheets qua writeQueue

---

## TASK 3.7 — API endpoint

- Thêm `GET /api/duplicates`
- Response format:

```json
{
  "confirmed": [
    {
      "confidence": "confirmed",
      "reason": "sha256_hash",
      "recommendedFile": "/books/Dac Nhan Tam.epub",
      "files": [
        { "path": "/books/Dac Nhan Tam.epub", "size": 524288, "ext": "epub", "recommended": true },
        { "path": "/books/dac_nhan_tam.epub", "size": 524288, "ext": "epub", "recommended": false }
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

---

## TASK 3.8 — UI: Tab Duplicates

- Thêm tab **"⚠️ Duplicates"** vào navigation (cạnh All Books, Search)
- Badge hiển thị tổng số group trên tab
- Hiển thị stat: tổng số group + tổng dung lượng có thể giải phóng

**Layout mỗi duplicate group:**

```
🔴 Confirmed  |  Đắc Nhân Tâm Dale Carnegie  |  2 files  |  Có thể giải phóng: 5.1MB
  ⭐ [EPUB] /books/Dac Nhan Tam.epub          |  512 KB   |  [Recommended - Giữ lại]
     [EPUB] /books/dac_nhan_tam_copy.epub     |  512 KB   |  [🗑 Xóa file này]
```

- Confidence badge: `🔴 Confirmed` / `🟡 Probable` / `🟠 Possible`
- Sắp xếp: Confirmed trước → Probable → Possible
- File được recommend: highlight nền khác màu, badge `⭐ Recommended`
- File còn lại: nút `🗑 Xóa file này`

---

## TASK 3.9 — Delete functionality

- Thêm endpoint `DELETE /api/books/file`
- Request body: `{ "location": "/books/path/to/file.pdf" }`
- Backend thực hiện theo thứ tự:
  1. Xác nhận file tồn tại trên NAS (`fs.existsSync`)
  2. Xóa file (`fs.unlink`)
  3. Xóa record khỏi `cachedBooks`
  4. Enqueue xóa row khỏi Sheets (qua `writeQueue`)
  5. Gọi `cacheManager.save()` để cập nhật JSON cache
- UI thực hiện theo thứ tự:
  1. Hiện confirm dialog: _"Xóa vĩnh viễn [tên file]? Hành động này không thể hoàn tác."_
  2. Sau khi delete thành công → xóa file row khỏi group
  3. Nếu group chỉ còn 1 file → xóa luôn group đó
  4. Cập nhật lại badge count và stats
  5. **Không** tự động xóa file recommended — luôn để user quyết định

---

## Files cần tạo / chỉnh sửa

```
backend/
  services/
    duplicateDetector.service.js   ← tạo mới
  api/
    duplicates.route.js            ← tạo mới (hoặc thêm vào routes hiện có)

frontend/
  app.js (hoặc ui.renderer.js)    ← thêm tab Duplicates + delete UI
```
