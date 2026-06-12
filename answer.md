# Project Architecture & Details

## 1. Cache / Data flow

- **Backend Startup & Memory**: Backend **không** load toàn bộ data vào memory ngay khi startup. Thay vào đó, nó sử dụng một cơ chế **lazy loading cache**. Data chỉ được fetch từ Google Sheets API trong lần đầu tiên có request yêu cầu danh sách sách (hoặc khi thực hiện sync/scan). Sau đó, data được lưu vào biến `cachedBooks` trong memory để phục vụ các request tiếp theo. Cache này có thể được force refresh thông qua các action như `Force Scan` hoặc `Sync`.
- **UI Data Flow**: Khi UI load danh sách sách, data đến từ **Backend** (endpoint `/api/books`). Backend sẽ trả về dữ liệu từ `cachedBooks` (nếu đã có) hoặc fetch mới từ Sheets API nếu cache trống. UI không gọi trực tiếp Sheets API để bảo mật credentials và tối ưu hóa performance.

## 2. Sync flow

- **Scanner Schedule**: Hiện tại, scanner **không chạy theo schedule cố định** (như cron job). Nó được kích hoạt theo các sự kiện:
    1. Khi server start (một lần).
    2. Khi người dùng click nút "Force Scan" hoặc "Sync Library" trên UI.
- **Worker Writing**: Khi Goodreads worker (trong `enrichmentService.js`) scrape xong một cuốn, nó **ghi thẳng vào Sheets ngay lập tức** (thông qua hàm `saveBook`). Đồng thời, nó cũng cập nhật lại bản ghi đó trong `cachedBooks` của backend để UI có thể phản ánh thay đổi ngay lập tức (jitter-free update) mà không cần reload toàn bộ danh sách.

## 3. Sheets structure

- **Số lượng cột**: Hiện tại Sheet có **11 cột**.
- **Cột chính**:
    1. `Goodreads Check`: Trạng thái kiểm tra (Yes/No/Not Found/Error).
    2. `Goodreads ID`: ID của sách trên Goodreads (nếu có).
    3. `Title`: Tiêu đề sách.
    4. `Author`: Tác giả.
    5. `Year`: Năm xuất bản.
    6. `Rating`: Điểm đánh giá.
    7. `Number of user rating`: Số lượng đánh giá.
    8. `Cover URL`: Link ảnh bìa.
    9. `Source`: Nguồn data (ví dụ: Filename Parser).
    10. `File Size`: Dung lượng file.
    11. `Location`: Đường dẫn tương đối của file trên disk.
- **Trigger re-fetch**: Hệ thống dựa vào cột **`Goodreads Check`**. Những hàng có giá trị `No` hoặc những hàng có `Goodreads ID` nhưng được parse từ Filename (chưa có metadata đầy đủ) sẽ được đưa vào hàng đợi để enrichment worker xử lý.

## 4. Scale hiện tại

- **Số lượng books**: (Thông tin này phụ thuộc vào thực tế data trong Sheet của bạn). Tuy nhiên, code được thiết kế để handle hàng ngàn bản ghi nhờ infinite scroll ở frontend và lazy cache ở backend.
- **Goodreads Workers**: Hiện tại đang chạy **3 workers song song** (`NUM_WORKERS = 3` trong `enrichmentService.js`). Mỗi worker có cơ chế jitter (delay ngẫu nhiên) để tránh bị Goodreads block.

## 5. Pain points (Phân tích dựa trên code)

- **Vấn đề khó chịu nhất (trước đó)**: Chính là sự "jitter" (giật lag) của UI khi data được update từ worker. Mỗi khi một cuốn sách được fetch xong, nếu reload toàn bộ list sẽ gây khó chịu cho người dùng. Đây là lý do chúng ta vừa refactor sang "Smart DOM Sync".
- **Lý do refactor**: 
    1. **Tối ưu UX**: Đảm bảo UI mượt mà ngay cả khi background workers đang hoạt động liên tục.
    2. **Maintainability**: Code cũ (`app.js`) quá lớn và lồng nhau, khó bảo trì. Việc tách nhỏ hàm giúp tuân thủ Clean Code rules.
    3. **Scalability**: Chuẩn bị cho việc quản lý thư viện lớn (hàng chục nghìn cuốn) mà không làm lag trình duyệt.
    4. **Sự ổn định**: Cải thiện cơ chế sync giữa File System và Google Sheets để tránh mất dữ liệu hoặc trùng lặp.
