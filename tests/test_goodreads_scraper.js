const axios = require('axios');
const cheerio = require('cheerio');

async function testAdvancedScraper(searchQuery) {
    console.log(`=== TESTING ADVANCED GOODREADS SCRAPER ===`);
    const url = `https://www.goodreads.com/search?q=${encodeURIComponent(searchQuery)}`;
    
    try {
        // Giả lập Headers cực kỳ chi tiết như trình duyệt thật
        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': 'https://www.google.com/',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0'
            }
        });

        const $ = cheerio.load(response.data);
        
        // Kiểm tra xem có phải trang kết quả không hay là trang CAPTCHA
        if ($('title').text().includes('Robot Check') || response.data.includes('api-services-support@goodreads.com')) {
            console.error("❌ FAILED: Still blocked by Goodreads Robot Check.");
            return;
        }

        const firstResult = $('table.tableList tr').first();

        if (firstResult.length > 0) {
            const bookTitle = firstResult.find('a.bookTitle span').text().trim();
            const bookAuthor = firstResult.find('a.authorName span').text().trim();
            const ratingText = firstResult.find('span.minirating').text().trim();
            
            console.log("\n✅ SUCCESS! Goodreads accepted the request.");
            console.log(`- Title:  ${bookTitle}`);
            console.log(`- Author: ${bookAuthor}`);
            console.log(`- Info:   ${ratingText}`);
        } else {
            console.log("❓ No results found, but not blocked.");
        }
        
    } catch (err) {
        console.error("❌ ERROR:", err.message);
    }
}

testAdvancedScraper("The Great Gatsby");
