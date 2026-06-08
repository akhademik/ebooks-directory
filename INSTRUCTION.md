Hãy đóng vai một chuyên gia Fullstack Developer và DevOps có tư duy hệ thống và cực kỳ cẩn trọng. Tôi muốn bạn hướng dẫn tôi xây dựng từ đầu một ứng dụng quản lý sách cá nhân (Book Library) có cấu trúc phẳng, tối giản: Vanilla JS frontend, Node.js backend, chạy trong 1 Docker container duy nhất.

Hệ thống sẽ scan đệ quy một thư mục sách mount từ NAS (gồm .pdf, .epub, .mobi, .azw, .azw3), nhận diện tên/tác giả, tra cứu metadata từ Open Library API (hoặc fallback sang Google Books API), và lưu vào Google Sheets làm Database.

### 🔴 QUY TẮC LÀM VIỆC (BẮT BUỘC):

1. CHIA LÀM TỪNG BƯỚC: Bạn phải chia dự án này ra làm các bước nhỏ logic (ví dụ: Bước 1: Setup & Cơ chế Parser, Bước 2: Google Sheets, Bước 3: Express API & Scanner, Bước 4: Frontend, Bước 5: Docker).
2. DỪNG LẠI CHỜ CONFIRM: Chỉ viết HOÀN CHỈNH CODE của MỘT BƯỚC trong một phản hồi. Sau khi xong mỗi bước, bạn phải DỪNG LẠI, báo cáo kết quả và CHỜ TÔI CONFIRM gõ "Tiếp tục" hoặc "OK" thì mới được chuyển sang bước tiếp theo.
3. LUÔN CÓ PHẦN KIỂM TRA (ANTI-BUG / REDUNDANCY): Trong mỗi bước, ngoài code chính, bạn bắt buộc phải viết kèm các đoạn mã TEST (ví dụ: test script chạy độc lập bằng Node.js) để kiểm tra:
   - Không bị trùng lặp dữ liệu (duplicate records).
   - Xử lý các edge cases (tên file dị, lỗi mạng, mất kết nối API, token hết hạn).
   - Đảm bảo khi chạy test không ra bất kỳ Warning hay lỗi bất thường nào thì mới coi là hoàn thành bước đó.

---

### Yêu Cầu Kiến Trúc Tổng Thể để Bạn Nắm Rõ:

book-library/
├── backend/
│ ├── scanner.js # Scan file đệ quy + Parse tên file + Fetch API metadata
│ ├── sheets.js # Kết nối và đồng bộ với Google Sheets API (Cấm ghi đè nếu cột status = 'manual')
│ ├── server.js # Express API + Serve tĩnh folder frontend (Port 3000)
│ └── package.json
├── frontend/
│ ├── index.html # UI đẹp với Tailwind CSS CDN, dạng Book Grid, có thanh Search/Filter
│ ├── app.js # Vanilla JS gọi API, render dữ liệu
│ └── style.css
├── Dockerfile
├── docker-compose.yml
└── .env.example

---

### BẮT ĐẦU: BƯỚC 1 - SETUP DỰ ÁN, FILE PARSER & METADATA FETCHING

Hãy viết code cho `backend/package.json` và file `backend/scanner.js` chứa:

1. Hàm Regex thông minh để clean tên file thô, tách `title` và `author` dự kiến.
2. Hàm fetch metadata từ Open Library API (`https://openlibrary.org/search.json?title=...`) để lấy `title`, `author_name`, `first_publish_year`, `cover_i` (build link ảnh lớn `-L.jpg`), và `ratings_average`. Fallback sang Google Books nếu Open Library không ra kết quả.
3. Viết một đoạn mã TEST (Test Script) nằm ngay trong file hoặc file riêng để tôi có thể chạy thử nghiệm quét + parse + fetch với 3-5 tên file thực tế (bao gồm tên file chuẩn, tên file chứa ký tự lạ, tên file thiếu thông tin). Nếu pass hết test không warning, hãy dừng lại và hỏi tôi để sang Bước 2.
