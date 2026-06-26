// Quizzes index: tag filtering + pagination. Mirrors tutorials.js, but sorts
// by quiz `order` (asc) instead of date and operates on the quizzes grid.
document.addEventListener('DOMContentLoaded', function () {
    const QUIZZES_PER_PAGE = 9;

    const tagBtns = document.querySelectorAll('.filter-btn[data-tag]');
    const levelBtns = document.querySelectorAll('.filter-btn[data-level]');
    const container = document.getElementById('quizzes-container');
    const pagination = document.getElementById('pagination');
    const paginationInfo = document.getElementById('pagination-info');
    const noResults = document.getElementById('no-results');
    if (!container) return;

    let currentPage = 1;
    let selectedTags = [];    // AND logic — card must have ALL selected tags
    let selectedLevels = [];  // OR logic — card matches ANY selected level
    const allCards = Array.from(container.querySelectorAll('.post-card'));
    let filtered = [...allCards];

    init();

    function init() {
        loadStateFromURL();
        tagBtns.forEach(btn => btn.addEventListener('click', () => toggleFilter(selectedTags, btn.dataset.tag)));
        levelBtns.forEach(btn => btn.addEventListener('click', () => toggleFilter(selectedLevels, btn.dataset.level)));
        applyFilters();
    }

    function loadStateFromURL() {
        const params = new URLSearchParams(window.location.search);
        const tags = params.get('tags');
        const levels = params.get('levels');
        const page = params.get('page');
        if (tags) selectedTags = tags.split(',');
        if (levels) selectedLevels = levels.split(',');
        if (page) currentPage = parseInt(page, 10) || 1;
        updateActiveFilters();
    }

    function updateURL() {
        const params = new URLSearchParams();
        if (selectedTags.length > 0) params.set('tags', selectedTags.join(','));
        if (selectedLevels.length > 0) params.set('levels', selectedLevels.join(','));
        if (currentPage !== 1) params.set('page', currentPage);
        const newURL = params.toString()
            ? `${window.location.pathname}?${params}`
            : window.location.pathname;
        window.history.replaceState({}, '', newURL);
    }

    function toggleFilter(list, value) {
        const i = list.indexOf(value);
        if (i > -1) list.splice(i, 1);
        else list.push(value);
        currentPage = 1;
        updateActiveFilters();
        applyFilters();
    }

    function updateActiveFilters() {
        tagBtns.forEach(btn => btn.classList.toggle('active', selectedTags.includes(btn.dataset.tag)));
        levelBtns.forEach(btn => btn.classList.toggle('active', selectedLevels.includes(btn.dataset.level)));
    }

    function applyFilters() {
        filtered = allCards.filter(card => {
            const cardTags = card.dataset.tags.split(',').map(t => t.trim()).filter(Boolean);
            const tagsMatch = selectedTags.length === 0 || selectedTags.every(t => cardTags.includes(t));
            const levelMatch = selectedLevels.length === 0 || selectedLevels.includes(card.dataset.difficulty);
            return tagsMatch && levelMatch;
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
