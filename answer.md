# Phân tích Yêu cầu Fix 3 (Duplicate Detection & UI)

Dựa trên file `@task.md` mới nhất và hiện trạng codebase của chúng ta, tôi đã rà soát và đối chiếu. Dưới đây là báo cáo chi tiết về những gì đã có, những gì cần làm và những gì KHÔNG NÊN làm.

---

## ✅ 1. Những phần ĐÃ ĐƯỢC LÀM SẴN (Không cần làm lại)

Các task sau đây đã được hoàn thiện trong các bước trước đó, và thậm chí làm tốt hơn yêu cầu:

*   **TASK 3.2 — Duplicate detector module**: Đã tạo `backend/services/duplicateDetector.service.js`. Đã có luôn cả cơ chế Caching (`duplicates.cache.json`) và Pre-calculate Bigrams để tối ưu hiệu năng.
*   **TASK 3.3 — Tầng 1 (SHA256) & Tầng 3 (Goodreads ID)**: Đã được code chính xác.
*   **TASK 3.4 — Background hash worker**: Đã tích hợp hoàn chỉnh vào cuối chu trình của `enrichmentService.js`.
*   **TASK 3.6 — Cột "File Hash" trên Sheets**: Đã config index 11 và tự động đồng bộ.
*   **TASK 3.9 — Delete functionality**: Đã code cả Backend (xóa NAS, xóa Cache, enqueue Queue) và Frontend (Session tracking, API call). 

---

## 🚀 2. Những phần CẦN PHẢI LÀM (Sẽ triển khai tiếp)

Đây là những nâng cấp cốt lõi về thuật toán và UI dựa theo file `@task.md` mới:

*   **TASK 3.1 & 3.3 — Nâng cấp Tầng 2 & Tầng 4**:
    *   **Tầng 2 (Mới):** Cần đổi từ `Cùng Size` sang **Fuzzy Title Match (>= 70%)**. Cần code thêm hàm loại bỏ dấu Tiếng Việt và các suffix phổ biến (như `_copy`, `(scan)`) trước khi so sánh.
    *   **Tầng 4 (Mới):** Cần đổi từ `Cùng Tên` sang **Cùng Extension + Size lệch không quá 10%**.
*   **TASK 3.5 — Recommendation Engine (Tính năng cốt lõi mới)**:
    *   Thêm logic ở Backend để chọn ra 1 file tốt nhất trong nhóm dựa trên luồng ưu tiên: Format (EPUB > PDF) → Size (PDF lấy lớn nhất, EPUB lấy nhỏ nhất) → Tên file sạch → Modified Date.
*   **TASK 3.7 & 3.8 — Cập nhật UI Recommendation**:
    *   Trả về cờ `recommended: true` qua API.
    *   Highlight nền của file được chọn, thêm badge `⭐ Recommended`, các file kia hiện nút Delete.

---

## ⛔ 3. Những phần KHÔNG NÊN LÀM (Lý do kỹ thuật)

Dựa vào tình hình thực tế, tôi đề xuất bỏ qua hoặc điều chỉnh các yêu cầu sau:

1.  **KHÔNG NÊN làm TASK 3.1 (Cài thêm package `unidecode`)**:
    *   *Lý do*: Việc thêm thư viện external chỉ để bỏ dấu Tiếng Việt là không cần thiết và đi ngược lại tiêu chí "nhẹ gọn". 
    *   *Giải pháp thay thế*: Chúng ta đã có sẵn hàm `removeAccents` cực kỳ chuẩn xác tự viết bằng Vanilla JS ở frontend. Chỉ cần copy logic này sang backend là xong, 0 dependency.
2.  **KHÔNG NÊN làm TASK 3.9 UI Bước 1 (Dùng `confirm()` dialog mặc định)**:
    *   *Lý do*: Trong task yêu cầu hiện dialog "Xóa vĩnh viễn [tên file]?". Nhưng thực tế chúng ta vừa thiết kế một cái Modal CSS cực kỳ xịn xò (Task 5 lúc nãy). 
    *   *Giải pháp*: Giữ nguyên cái Custom Modal hiện tại, nó đẹp và an toàn hơn rất nhiều so với popup mặc định của trình duyệt.

---

**Kết luận:** Nếu bạn đồng ý với phân tích này, tôi sẽ bắt tay vào cập nhật thuật toán (Tầng 2 & Tầng 4) và viết hệ thống Recommendation Engine cho Backend!