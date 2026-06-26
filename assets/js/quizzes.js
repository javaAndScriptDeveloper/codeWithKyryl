// Quizzes index: tag filtering + pagination. Mirrors tutorials.js, but sorts
// by quiz `order` (asc) instead of date and operates on the quizzes grid.
document.addEventListener('DOMContentLoaded', function () {
    const QUIZZES_PER_PAGE = 9;

    const filterBtns = document.querySelectorAll('.filter-btn');
    const container = document.getElementById('quizzes-container');
    const pagination = document.getElementById('pagination');
    const paginationInfo = document.getElementById('pagination-info');
    const noResults = document.getElementById('no-results');
    if (!container) return;

    let currentPage = 1;
    let selectedTags = [];
    const allCards = Array.from(container.querySelectorAll('.post-card'));
    let filtered = [...allCards];

    init();

    function init() {
        loadStateFromURL();
        filterBtns.forEach(btn => btn.addEventListener('click', handleFilter));
        applyFilters();
    }

    function loadStateFromURL() {
        const params = new URLSearchParams(window.location.search);
        const tags = params.get('tags');
        const page = params.get('page');
        if (tags) { selectedTags = tags.split(','); updateActiveFilters(); }
        if (page) currentPage = parseInt(page, 10) || 1;
    }

    function updateURL() {
        const params = new URLSearchParams();
        if (selectedTags.length > 0) params.set('tags', selectedTags.join(','));
        if (currentPage !== 1) params.set('page', currentPage);
        const newURL = params.toString()
            ? `${window.location.pathname}?${params}`
            : window.location.pathname;
        window.history.replaceState({}, '', newURL);
    }

    function handleFilter(e) {
        const clickedTag = e.currentTarget.dataset.tag;
        const i = selectedTags.indexOf(clickedTag);
        if (i > -1) selectedTags.splice(i, 1);
        else selectedTags.push(clickedTag);
        currentPage = 1;
        updateActiveFilters();
        applyFilters();
    }

    function updateActiveFilters() {
        filterBtns.forEach(btn => {
            btn.classList.toggle('active', selectedTags.includes(btn.dataset.tag));
        });
    }

    function applyFilters() {
        filtered = allCards.filter(card => {
            if (selectedTags.length === 0) return true;
            const cardTags = card.dataset.tags.split(',').map(t => t.trim()).filter(Boolean);
            return selectedTags.every(t => cardTags.includes(t));
        });
        // Stable order by quiz `order` ascending
        filtered.sort((a, b) =>
            (parseInt(a.dataset.order, 10) || 0) - (parseInt(b.dataset.order, 10) || 0));
        renderCards();
        renderPagination();
        updateURL();
    }

    function renderCards() {
        allCards.forEach(card => { card.classList.add('hidden'); card.style.display = 'none'; });

        if (filtered.length === 0) { noResults.style.display = 'block'; return; }
        noResults.style.display = 'none';

        const start = (currentPage - 1) * QUIZZES_PER_PAGE;
        const end = start + QUIZZES_PER_PAGE;
        filtered.slice(start, end).forEach(card => {
            card.classList.remove('hidden'); card.style.display = 'block';
        });

        const total = filtered.length;
        const showingStart = Math.min(start + 1, total);
        const showingEnd = Math.min(end, total);
        paginationInfo.textContent = `Showing ${showingStart}-${showingEnd} of ${total} quizzes`;
    }

    function renderPagination() {
        const totalPages = Math.ceil(filtered.length / QUIZZES_PER_PAGE);
        if (totalPages <= 1) { pagination.innerHTML = ''; return; }

        let html = `<button onclick="changeQuizPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left"></i></button>`;

        const maxVisible = 5;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage + 1 < maxVisible) startPage = Math.max(1, endPage - maxVisible + 1);

        if (startPage > 1) {
            html += '<button onclick="changeQuizPage(1)">1</button>';
            if (startPage > 2) html += '<button disabled>...</button>';
        }
        for (let i = startPage; i <= endPage; i++) {
            html += `<button onclick="changeQuizPage(${i})" ${i === currentPage ? 'class="active"' : ''}>${i}</button>`;
        }
        if (endPage < totalPages) {
            if (endPage < totalPages - 1) html += '<button disabled>...</button>';
            html += `<button onclick="changeQuizPage(${totalPages})">${totalPages}</button>`;
        }
        html += `<button onclick="changeQuizPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>
                <i class="fas fa-chevron-right"></i></button>`;
        pagination.innerHTML = html;
    }

    window.changeQuizPage = function (page) {
        const totalPages = Math.ceil(filtered.length / QUIZZES_PER_PAGE);
        if (page >= 1 && page <= totalPages) {
            currentPage = page;
            renderCards();
            renderPagination();
            updateURL();
            const header = document.querySelector('.tutorials-header');
            if (header) header.scrollIntoView({ behavior: 'smooth' });
        }
    };
});
