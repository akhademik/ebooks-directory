let allBooks = [];
let currentView = 'grid'; // 'grid' or 'list'

const ELEMENTS = {
    bookGrid: () => document.getElementById('bookGrid'),
    emptyState: () => document.getElementById('emptyState'),
    searchInput: () => document.getElementById('searchInput'),
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
    previewContent: () => document.getElementById('previewContent'),
    gridBtn: () => document.getElementById('gridBtn'),
    listBtn: () => document.getElementById('listBtn')
};

const UI_CLASSES = {
    disabled: 'opacity-50',
    noCursor: 'cursor-not-allowed',
    spinning: 'spinning',
    hidden: 'hidden',
    activeBtn: ['bg-slate-700', 'text-indigo-400', 'shadow-sm'],
    inactiveBtn: ['text-slate-400', 'hover:text-slate-200']
};

document.addEventListener('DOMContentLoaded', () => {
    fetchBooks();

    ELEMENTS.searchInput().addEventListener('input', (e) => {
        filterBooks(e.target.value);
    });

    ELEMENTS.scanBtn().addEventListener('click', startScan);
    
    ELEMENTS.closeModal().addEventListener('click', hidePreview);
    ELEMENTS.modalOverlay().addEventListener('click', hidePreview);

    ELEMENTS.gridBtn().addEventListener('click', () => switchView('grid'));
    ELEMENTS.listBtn().addEventListener('click', () => switchView('list'));
});

function switchView(view) {
    currentView = view;
    const gridBtn = ELEMENTS.gridBtn();
    const listBtn = ELEMENTS.listBtn();
    const grid = ELEMENTS.bookGrid();

    if (view === 'grid') {
        gridBtn.classList.add(...UI_CLASSES.activeBtn);
        gridBtn.classList.remove(...UI_CLASSES.inactiveBtn);
        listBtn.classList.remove(...UI_CLASSES.activeBtn);
        listBtn.classList.add(...UI_CLASSES.inactiveBtn);
        grid.classList.remove('list-view');
    } else {
        listBtn.classList.add(...UI_CLASSES.activeBtn);
        listBtn.classList.remove(...UI_CLASSES.inactiveBtn);
        gridBtn.classList.remove(...UI_CLASSES.activeBtn);
        gridBtn.classList.add(...UI_CLASSES.inactiveBtn);
        grid.classList.add('list-view');
    }
    renderBooks(allBooks);
}

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
        card.className = 'book-card bg-slate-900 rounded-xl overflow-hidden shadow-lg border border-slate-800 flex flex-col relative cursor-pointer hover:border-indigo-500/50 transition-all active:scale-95';
        card.style.animationDelay = `${index * 0.02}s`;
        card.onclick = () => showPreview(book);
        
        const coverUrl = book.cover && book.cover !== 'null' ? book.cover : `https://ui-avatars.com/api/?name=${encodeURIComponent(book.title)}&size=300&background=1e293b&color=6366f1&bold=true&format=svg`;
        const ratingStars = isNaN(book.rating) || !book.rating ? '' : '★'.repeat(Math.round(book.rating)) + '☆'.repeat(5 - Math.round(book.rating));
        
        const ext = book.location ? book.location.split('.').pop().toLowerCase() : 'book';
        const badgeClass = `badge-${ext}`;

        const badgeHtml = `<div class="format-badge ${badgeClass}">${ext}</div>`;

        card.innerHTML = `
            ${currentView === 'grid' ? badgeHtml : ''}
            <div class="cover-container relative group bg-slate-800">
                <img src="${coverUrl}" alt="${book.title}" class="cover-img w-full h-full object-cover" loading="lazy" 
                     onerror="this.onerror=null; this.src='https://via.placeholder.com/300x450/1e293b/64748b?text=No+Cover'">
                ${currentView === 'grid' ? `
                <div class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                    <i class="fas fa-eye text-white text-2xl"></i>
                </div>` : ''}
            </div>

            <div class="p-3">
                <h3 class="font-bold text-slate-100 line-clamp-2 leading-snug" title="${book.title}">${book.title}</h3>
                <p class="author-text text-slate-400 truncate">${book.author}</p>
                <div class="meta-text text-slate-500">
                    <span class="font-bold text-indigo-400/80">${book.year !== 'N/A' ? book.year : ''}</span>
                    <span class="text-amber-500/80">${ratingStars}</span>
                </div>
                ${currentView === 'list' ? badgeHtml : ''}
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

function hidePreview() {
    ELEMENTS.previewModal().classList.add(UI_CLASSES.hidden);
    document.body.style.overflow = '';
}

async function showPreview(book) {
    const modal = ELEMENTS.previewModal();
    const title = ELEMENTS.previewTitle();
    const content = ELEMENTS.previewContent();

    title.innerText = `Preview: ${book.title}`;
    content.innerHTML = `
        <div class="flex flex-col items-center justify-center py-20 text-indigo-400">
            <div class="animate-spin text-4xl mb-4">
                <i class="fas fa-circle-notch"></i>
            </div>
            <p class="font-medium">Generating your preview...</p>
        </div>
    `;
    
    modal.classList.remove(UI_CLASSES.hidden);
    document.body.style.overflow = 'hidden';

    try {
        const response = await fetch(`/api/preview/${book.rowIndex}`);
        const data = await response.json();

        if (data.type === 'pdf') {
            content.innerHTML = `
                <div class="flex flex-col gap-8 max-w-3xl mx-auto">
                    ${data.images.map(img => `
                        <div class="bg-white rounded-lg shadow-2xl overflow-hidden border border-slate-800">
                            <img src="${img}" class="w-full h-auto" loading="lazy">
                        </div>
                    `).join('')}
                    <div class="py-10 text-center text-slate-500 text-sm italic">
                        Preview ends here.
                    </div>
                </div>
            `;
        } else if (data.type === 'epub') {
            content.innerHTML = `
                <div class="max-w-2xl mx-auto prose prose-invert prose-slate prose-indigo">
                    ${data.chapters.map(chap => `
                        <div class="mb-12">
                            <h2 class="text-2xl font-bold text-indigo-400 border-b border-slate-800 pb-2 mb-6">${chap.title}</h2>
                            <div class="epub-preview-content text-slate-300 leading-relaxed text-lg">
                                ${chap.content}
                            </div>
                        </div>
                    `).join('')}
                    <div class="py-10 text-center text-slate-500 text-sm italic border-t border-slate-800">
                        Preview ends here.
                    </div>
                </div>
            `;
        }
    } catch (error) {
        console.error('Preview error:', error);
        content.innerHTML = `<div class="text-center py-20 text-red-400">Could not load preview. ${error.message}</div>`;
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
