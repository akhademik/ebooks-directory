const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

/**
 * Scrapes book metadata from Goodreads.
 * Can search by title/author string or go directly to a Goodreads ID.
 */
async function scrapeGoodreads(searchQuery, goodreadsId = '') {
    const browser = await puppeteer.launch({ 
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        let bookUrl = '';

        if (goodreadsId) {
            bookUrl = `https://www.goodreads.com/book/show/${goodreadsId}`;
            console.log(`[Scraper] Going directly to Goodreads ID: ${goodreadsId}`);
            await page.goto(bookUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } else {
            const searchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(searchQuery)}`;
            console.log(`[Scraper] Searching Goodreads for: ${searchQuery}`);
            
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            // Wait for search results
            const BOOK_TITLE_SELECTOR = 'a.bookTitle';
            try {
                await page.waitForSelector(BOOK_TITLE_SELECTOR, { timeout: 10000 });
            } catch (err) {
                console.log(`[Scraper] Timeout waiting for ${BOOK_TITLE_SELECTOR}: ${err.message}`);
            }
            
            bookUrl = await page.evaluate((selector) => {
                const link = document.querySelector(selector) || 
                             document.querySelector('.bookTitle') || 
                             document.querySelector('a[href*="/book/show/"]');
                return link ? link.href : null;
            }, BOOK_TITLE_SELECTOR);

            if (!bookUrl) {
                console.log(`[Scraper] No link found, trying fallback title-only search...`);
                // Simple title-only search if first one failed
                const titleOnly = searchQuery.split(' ')[0]; // Very simple fallback
                await page.goto(`https://www.goodreads.com/search?q=${encodeURIComponent(titleOnly)}`, { waitUntil: 'domcontentloaded' });
                bookUrl = await page.evaluate((selector) => {
                    const link = document.querySelector(selector) || document.querySelector('a[href*="/book/show/"]');
                    return link ? link.href : null;
                }, BOOK_TITLE_SELECTOR);
            }
        }

        if (!bookUrl) {
            console.log(`[Scraper] No book URL found.`);
            await browser.close();
            return null;
        }

        console.log(`[Scraper] Navigating to: ${bookUrl}`);
        if (page.url() !== bookUrl) {
            await page.goto(bookUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        
        await page.waitForSelector('h1[data-testid="bookTitle"]', { timeout: 15000 }).catch(() => null);

        const data = await page.evaluate(() => {
            const getTxt = (sel) => document.querySelector(sel)?.innerText?.trim() || '';
            
            const title = getTxt('h1[data-testid="bookTitle"]') || getTxt('#bookTitle');
            const author = getTxt('.ContributorLink__name') || getTxt('.authorName') || getTxt('[data-testid="name"]');
            const ratingTxt = getTxt('.RatingStatistics__rating') || getTxt('[itemprop="ratingValue"]');
            const cover = document.querySelector('.BookCover__image img')?.src || document.querySelector('#coverImage')?.src || '';
            
            const pubInfo = getTxt('.FeaturedDetails p[data-testid="publicationInfo"]') || getTxt('#details .row:last-child') || '';
            const yearMatch = pubInfo.match(/(\d{4})/);
            const year = yearMatch ? yearMatch[1] : 'N/A';

            // Extract ID from URL (e.g., /book/show/4671.The_Great_Gatsby)
            const url = window.location.href;
            const idMatch = url.match(/\/show\/(\d+)/);
            const extractedId = idMatch ? idMatch[1] : '';

            return { 
                title, 
                author, 
                rating: isNaN(parseFloat(ratingTxt)) ? 'N/A' : parseFloat(ratingTxt).toFixed(1), 
                cover, 
                year,
                url,
                goodreadsId: extractedId
            };
        });

        await browser.close();
        return data;
    } catch (err) {
        console.error(`[Scraper Error] ${err.message}`);
        if (browser) await browser.close();
        return null;
    }
}

module.exports = { scrapeGoodreads };
