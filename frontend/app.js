let allBooks = [];
let currentPage = 1;
const BOOKS_PER_PAGE = 20;

const ELEMENTS = {
    bookGrid: () => document.getElementById('bookGrid'),
    emptyState: () => document.getElementById('emptyState'),
    searchInput: () => document.getElementById('searchInput'),
    typeFilter: () => document.getElementById('typeFilter'),
    scanBtn: () => document.getElementById('scanBtn'),
    scanIcon: () => document.getElementById('scanIcon'),
    statusArea: () => document.getElementById('statusArea'),
    statusText: () => document.getElementById('statusText'),
    scanProgress: () => document.getElementById('scanProgress'),
    progressBar: () => document.getElementById('progressBar'),
    previewModal: () => document.getElementById('previewModal'),
    modalOverlay: () => document.getElementById('modalOverlay'),
    closeModal: () => document.getElementById('closeModal'),
    previewTitle: () => document.getElementById('previewTitle'),
    previewContent: () => document.getElementById('previewContent')
};

const UI_CLASSES = {
    disabled: 'opacity-50',
    noCursor: 'cursor-not-allowed',
    spinning: 'spinning',
    hidden: 'hidden'
};

const SUPPORTED_PREVIEW_EXTS = ['pdf', 'epub'];

document.addEventListener('DOMContentLoaded', () => {
    fetchBooks();
    startScan(); 

    // Filters
    ELEMENTS.searchInput().addEventListener('input', () => resetAndRender());
    ELEMENTS.typeFilter().addEventListener('change', () => resetAndRender());

    ELEMENTS.scanBtn().addEventListener('click', startScan);
    
    ELEMENTS.closeModal().addEventListener('click', hidePreview);
    ELEMENTS.modalOverlay().addEventListener('click', hidePreview);

    // Infinite Scroll - Bind to window, check scrolling
    window.addEventListener('scroll', () => {
        // Optimized check: 200px before end
        const scrollPosition = window.innerHeight + window.scrollY;
        const pageHeight = document.documentElement.scrollHeight;
        if (scrollPosition >= pageHeight - 500) {
            loadNextPage();
        }
    });
});

function resetAndRender() {
    currentPage = 1;
    renderBooks(getFilteredBooks());
}

function getFilteredBooks() {
    const query = ELEMENTS.searchInput().value.toLowerCase();
    const type = ELEMENTS.typeFilter().value;

    return allBooks.filter(book => {
        const matchesSearch = (book.title || '').toLowerCase().includes(query) || 
                              (book.author || '').toLowerCase().includes(query);
        const matchesType = !type || (book.location || '').toLowerCase().endsWith(type);
        return matchesSearch && matchesType;
    });
}

function loadNextPage() {
    const filtered = getFilteredBooks();
    if (currentPage * BOOKS_PER_PAGE >= filtered.length) return;
    
    currentPage++;
    renderBooks(filtered, true);
}

async function fetchBooks() {
    try {
        const response = await fetch('/api/books');
        allBooks = await response.json();
        renderBooks(getFilteredBooks());
    } catch (error) {
        console.error('Error fetching books:', error);
        showError('Could not load books.');
    }
}

function formatRatingCount(countStr) {
    if (!countStr) return '';
    const num = parseInt(countStr.toString().replace(/,/g, ''), 10);
    if (isNaN(num)) return countStr;
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return num.toString();
}

function renderBooks(books, append = false) {
    const grid = ELEMENTS.bookGrid();
    const emptyState = ELEMENTS.emptyState();
    
    if (!append) grid.innerHTML = '';
    
    if (books.length === 0) {
        if (!append) emptyState.classList.remove(UI_CLASSES.hidden);
        return;
    }
    
    emptyState.classList.add(UI_CLASSES.hidden);

    const start = append ? (currentPage - 1) * BOOKS_PER_PAGE : 0;
    const end = currentPage * BOOKS_PER_PAGE;
    const paginatedBooks = books.slice(start, end);
    
    paginatedBooks.forEach((book, index) => {
        const globalIndex = start + index + 1;
        const row = document.createElement('div');
        row.className = 'book-card list-view-grid hover:bg-white/5 transition-colors group relative';
        
        const ext = book.location ? book.location.split('.').pop().toLowerCase() : 'book';
        const isSupported = SUPPORTED_PREVIEW_EXTS.includes(ext);

        const defaultCover = `https://ui-avatars.com/api/?name=${encodeURIComponent(book.title)}&size=100&background=1e293b&color=6366f1&bold=true&format=svg`;
        let coverUrl = defaultCover;
        if (book.cover && book.cover.startsWith('http')) {
            coverUrl = book.cover;
        } else if (book.rowIndex) {
            coverUrl = `/api/cover/${book.rowIndex}`;
        }

        const ratingNum = parseFloat(book.rating);
        const ratingStars = isNaN(ratingNum) ? '' : '★'.repeat(Math.round(ratingNum));
        const formattedCount = formatRatingCount(book.ratingCount);
        const ratingDisplay = book.rating !== 'N/A' && book.rating !== '' ? book.rating : '';
        
        let combinedRating = '';
        if (ratingDisplay) {
            combinedRating = ratingDisplay;
            if (formattedCount) {
                combinedRating += ` (${formattedCount})`;
            }
        }
        
        const goodreadsUrl = book.goodreadsId ? `https://www.goodreads.com/book/show/${book.goodreadsId}` : '';
        const titleHtml = goodreadsUrl 
            ? `<a href="${goodreadsUrl}" target="_blank" class="text-white font-bold hover:text-indigo-400 transition-colors" title="View on Goodreads">${book.title}</a>`
            : `<span class="text-white font-bold">${book.title}</span>`;

        row.innerHTML = `
            <div class="text-slate-600 font-bold text-xs">${globalIndex}</div>
            <div class="flex items-center gap-4 min-w-0">
                <div class="w-10 h-14 bg-slate-800 rounded flex-shrink-0 overflow-hidden shadow-lg group-hover:scale-110 transition-transform cursor-pointer" onclick='showPreview(${JSON.stringify(book).replace(/'/g, "\\'").replace(/"/g, '&quot;')})'>
                    <img src="${coverUrl}" class="w-full h-full object-cover" loading="lazy" onerror="this.onerror=null; this.src='${defaultCover}'">
                </div>
                <div class="min-w-0 flex flex-col justify-center">
                    <div class="truncate text-sm mb-0.5 leading-tight">${titleHtml}</div>
                    <div class="truncate text-[11px] text-slate-500 font-medium">${book.author}</div>
                    <div class="flex items-center gap-2 mt-1">
                        <span class="star-rating">${ratingStars}</span>
                        <span class="text-[9px] text-slate-600 font-bold tracking-tight">${combinedRating}</span>
                    </div>
                </div>
            </div>
            <div>
                <span class="format-badge badge-${ext}">${ext}</span>
            </div>
            <div class="text-slate-500 text-xs font-mono">${book.size || '0.00'} MB</div>
            <div class="flex justify-center">
                <button class="action-btn btn-xem ${!isSupported ? 'opacity-20 cursor-not-allowed' : ''}" 
                        onclick='showPreview(${JSON.stringify(book).replace(/'/g, "\\'").replace(/"/g, '&quot;')})' 
                        ${!isSupported ? 'disabled' : ''}>
                    <i class="fas fa-eye"></i> Xem
                </button>
            </div>
            <div class="flex justify-center">
                <a href="/api/download/${book.rowIndex}" class="action-btn btn-tai">
                    <i class="fas fa-cloud-download-alt"></i> Tải
                </a>
            </div>
            ${book.status === 'manual' ? '<div class="absolute top-0 right-0 bg-amber-500 text-white px-2 py-0.5 rounded-bl-lg text-[9px] font-bold">MANUAL</div>' : ''}
        `;
        grid.appendChild(row);
    });
}

function hidePreview() {
    ELEMENTS.previewModal().classList.add(UI_CLASSES.hidden);
    document.body.style.overflow = '';
}

// eslint-disable-next-line no-unused-vars, sonarjs/no-unused-vars
async function showPreview(book) {
    const modal = ELEMENTS.previewModal();
    const title = ELEMENTS.previewTitle();
    const content = ELEMENTS.previewContent();

    title.innerText = `${book.title}`;
    content.innerHTML = `<div class="flex flex-col items-center justify-center py-20 text-indigo-400"><div class="animate-spin text-4xl mb-4"><i class="fas fa-circle-notch"></i></div><p class="font-bold tracking-widest text-xs uppercase">Preparing Preview</p></div>`;
    
    modal.classList.remove(UI_CLASSES.hidden);
    document.body.style.overflow = 'hidden';

    try {
        const response = await fetch(`/api/preview/${book.rowIndex}`);
        if (!response.ok) throw new Error('Preview unavailable');
        const data = await response.json();

        if (data.type === 'pdf') {
            const imagesHtml = data.images.map(img => `<div class="bg-white rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden border border-white/10"><img src="${img}" class="w-full h-auto"></div>`).join('');
            content.innerHTML = `<div class="flex flex-col gap-12 max-w-4xl mx-auto">${imagesHtml}<div class="py-20 text-center text-slate-600 text-xs font-bold uppercase tracking-widest">End of Preview</div></div>`;
        } else if (data.type === 'epub') {
            const chaptersHtml = data.chapters.map(chap => `<div class="mb-12"><div class="epub-preview-content text-lg leading-relaxed">${chap.content}</div></div>`).join('');
            content.innerHTML = `<div class="max-w-3xl mx-auto prose prose-invert prose-indigo">${chaptersHtml}<div class="py-20 text-center text-slate-600 text-xs font-bold uppercase tracking-widest border-t border-white/5">End of Preview</div></div>`;
        }
    } catch (error) {
        content.innerHTML = `<div class="text-center py-24 text-red-400 font-bold italic tracking-wide"><i class="fas fa-exclamation-triangle text-4xl mb-6 opacity-20 block"></i><p>PREVIEW FAILED: ${error.message.toUpperCase()}</p></div>`;
    }
}

async function startScan() {
    const scanBtn = ELEMENTS.scanBtn();
    const scanIcon = ELEMENTS.scanIcon();
    const statusArea = ELEMENTS.statusArea();
    const statusText = ELEMENTS.statusText();
    const scanProgress = ELEMENTS.scanProgress();
    const progressBar = ELEMENTS.progressBar();

    scanBtn.disabled = true;
    scanBtn.classList.add(UI_CLASSES.disabled);
    scanIcon.classList.add(UI_CLASSES.spinning);
    statusArea.classList.remove(UI_CLASSES.hidden);
    
    let lastProcessed = -1;

    try {
        await fetch('/api/scan');
    } catch (error) {
        console.error('Scan error:', error);
        return;
    }

    const pollStatus = setInterval(async () => {
        try {
            const response = await fetch('/api/scan/status');
            const data = await response.json();
            const { isScanning, isEnriching, results, enrichment } = data;

            if (isScanning) {
                const percent = Math.round((results.processed / results.total) * 100) || 0;
                progressBar.style.width = `${percent}%`;
                scanProgress.innerText = `${results.processed}/${results.total}`;
                statusText.innerText = `Pha 1: Quét hệ thống...`;
            } else if (isEnriching) {
                const percent = Math.round((enrichment.current / enrichment.total) * 100) || 0;
                progressBar.style.width = `${percent}%`;
                scanProgress.innerText = `${enrichment.current}/${enrichment.total}`;
                statusText.innerText = `Pha 2: Goodreads [${enrichment.currentTitle}]`;
                
                if (enrichment.current > lastProcessed) {
                    lastProcessed = enrichment.current;
                    fetchBooks();
                }
            }

            if (!isScanning && !isEnriching) {
                clearInterval(pollStatus);
                statusText.innerText = `Library Sync Complete`;
                progressBar.style.width = '100%';
                fetchBooks();
                setTimeout(() => statusArea.classList.add(UI_CLASSES.hidden), 3000);
                scanBtn.disabled = false;
                scanBtn.classList.remove(UI_CLASSES.disabled);
                scanIcon.classList.remove(UI_CLASSES.spinning);
            }
        } catch (error) {
            console.error('Polling error:', error);
        }
    }, 2000);
}

function showError(msg) {
    ELEMENTS.bookGrid().innerHTML = `<div class="col-span-full text-center py-32 text-red-500 font-black tracking-widest uppercase text-xs">${msg}</div>`;
}
