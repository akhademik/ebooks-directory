let allBooks = [];

const ELEMENTS = {
    bookGrid: () => document.getElementById('bookGrid'),
    emptyState: () => document.getElementById('emptyState'),
    searchInput: () => document.getElementById('searchInput'),
    scanBtn: () => document.getElementById('scanBtn'),
    scanIcon: () => document.getElementById('scanIcon'),
    statusArea: () => document.getElementById('statusArea'),
    statusText: () => document.getElementById('statusText'),
    scanProgress: () => document.getElementById('scanProgress'),
    progressBar: () => document.getElementById('progressBar')
};

document.addEventListener('DOMContentLoaded', () => {
    fetchBooks();

    ELEMENTS.searchInput().addEventListener('input', (e) => {
        filterBooks(e.target.value);
    });

    ELEMENTS.scanBtn().addEventListener('click', startScan);
});

async function fetchBooks() {
    try {
        const response = await fetch('/api/books');
        allBooks = await response.json();
        renderBooks(allBooks);
    } catch (error) {
        console.error('Error fetching books:', error);
        showError('Could not load books. Is the server running?');
    }
}

function renderBooks(books) {
    const grid = ELEMENTS.bookGrid();
    const emptyState = ELEMENTS.emptyState();
    
    grid.innerHTML = '';
    
    if (books.length === 0) {
        emptyState.classList.remove(UI_CLASSES.hidden);
        return;
    }
    
    emptyState.classList.add(UI_CLASSES.hidden);
    
    books.forEach((book, index) => {
        const card = document.createElement('div');
        card.className = 'book-card bg-slate-900 rounded-xl overflow-hidden shadow-lg border border-slate-800 flex flex-col relative';
        card.style.animationDelay = `${index * 0.02}s`;
        
        const coverUrl = book.cover && book.cover !== 'null' ? book.cover : `https://ui-avatars.com/api/?name=${encodeURIComponent(book.title)}&size=300&background=1e293b&color=6366f1&bold=true&format=svg`;
        const ratingStars = isNaN(book.rating) || !book.rating ? '' : '★'.repeat(Math.round(book.rating)) + '☆'.repeat(5 - Math.round(book.rating));

        card.innerHTML = `
            <div class="cover-container relative group bg-slate-800">
                <img src="${coverUrl}" alt="${book.title}" class="cover-img w-full h-full object-cover" loading="lazy" 
                     onerror="this.onerror=null; this.src='https://via.placeholder.com/300x450/1e293b/64748b?text=No+Cover'">
                <div class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                    <span class="text-white text-[10px] font-bold bg-indigo-600 px-2 py-1 rounded uppercase shadow-lg">${book.extension || ''}</span>
                </div>
            </div>

            <div class="p-3 flex flex-col flex-1">
                <h3 class="font-bold text-sm text-slate-100 line-clamp-2 leading-snug mb-1" title="${book.title}">${book.title}</h3>
                <p class="text-[11px] text-slate-400 mb-2 truncate">${book.author}</p>
                <div class="mt-auto flex items-center justify-between">
                    <span class="text-[10px] font-bold text-indigo-400">${book.year !== 'N/A' ? book.year : ''}</span>
                    <span class="text-amber-500 text-[10px]">${ratingStars}</span>
                </div>
            </div>
            ${book.status === 'manual' ? '<div class="absolute top-2 right-2 bg-amber-500 text-white p-1 rounded-full text-[8px] shadow-sm flex items-center justify-center w-5 h-5"><i class="fas fa-user-edit"></i></div>' : ''}
        `;
        grid.appendChild(card);
    });
}

function filterBooks(query) {
    const filtered = allBooks.filter(book => 
        book.title.toLowerCase().includes(query.toLowerCase()) || 
        book.author.toLowerCase().includes(query.toLowerCase())
    );
    renderBooks(filtered);
}

const UI_CLASSES = {
    disabled: 'opacity-50',
    noCursor: 'cursor-not-allowed',
    spinning: 'spinning',
    hidden: 'hidden'
};

async function startScan() {
    const scanBtn = ELEMENTS.scanBtn();
    const scanIcon = ELEMENTS.scanIcon();
    const statusArea = ELEMENTS.statusArea();
    const statusText = ELEMENTS.statusText();
    const scanProgress = ELEMENTS.scanProgress();
    const progressBar = ELEMENTS.progressBar();

    scanBtn.disabled = true;
    scanBtn.classList.add(UI_CLASSES.disabled, UI_CLASSES.noCursor);
    scanIcon.classList.add(UI_CLASSES.spinning);
    statusArea.classList.remove(UI_CLASSES.hidden);
    
    let lastProcessed = -1;

    // Start scanning
    try {
        await fetch('/api/scan');
    } catch (error) {
        console.error('Failed to trigger scan:', error);
        showError('Could not start scan.');
        return;
    }

    // Polling status
    const pollStatus = setInterval(async () => {
        try {
            const response = await fetch('/api/scan/status');
            const data = await response.json();
            const { isScanning, results } = data;

            // Update Progress Bar
            if (results.total > 0) {
                const percent = Math.round((results.processed / results.total) * 100);
                progressBar.style.width = `${percent}%`;
                scanProgress.innerText = `${results.processed}/${results.total}`;
                statusText.innerText = `Scanning: ${results.processed} of ${results.total} books...`;
            } else {
                statusText.innerText = "Finding books on NAS...";
            }

            // Only fetch books if something was actually added to Sheets
            if (results.added > lastProcessed) {
                lastProcessed = results.added;
                fetchBooks();
            }

            if (!isScanning) {
                clearInterval(pollStatus);
                statusText.innerText = `Scan Complete! Total: ${results.total}, New: ${results.added}, Skipped: ${results.skipped}.`;
                progressBar.style.width = '100%';
                
                setTimeout(() => {
                    statusArea.classList.add(UI_CLASSES.hidden);
                    scanBtn.disabled = false;
                    scanBtn.classList.remove(UI_CLASSES.disabled, UI_CLASSES.noCursor);
                    scanIcon.classList.remove(UI_CLASSES.spinning);
                }, 5000);
            }
        } catch (error) {
            console.error('Polling error:', error);
        }
    }, 1500);
}

function showError(msg) {
    const grid = ELEMENTS.bookGrid();
    grid.innerHTML = `<div class="col-span-full text-center py-20 text-red-400 font-medium">${msg}</div>`;
}
