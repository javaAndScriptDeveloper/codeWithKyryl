document.addEventListener('DOMContentLoaded', function() {
    // Configuration
    const POSTS_PER_PAGE = 9;

    // DOM elements
    const filterBtns = document.querySelectorAll('.filter-btn');
    const postsContainer = document.getElementById('posts-container');
    const pagination = document.getElementById('pagination');
    const paginationInfo = document.getElementById('pagination-info');
    const noResults = document.getElementById('no-results');

    // State
    let currentPage = 1;
    let selectedTags = []; // Changed from ['all'] to empty array
    let allPosts = Array.from(document.querySelectorAll('.post-card'));
    let filteredPosts = [...allPosts];

    // Initialize
    init();

    function init() {
        // Load state from URL
        loadStateFromURL();

        // Event listeners
        filterBtns.forEach(btn => btn.addEventListener('click', handleFilter));

        // Initial render - show all posts by default
        applyFilters();
    }

    function loadStateFromURL() {
        const params = new URLSearchParams(window.location.search);
        const tags = params.get('tags');
        const page = params.get('page');

        if (tags) {
            selectedTags = tags.split(',');
            updateActiveFilters();
        }

        if (page) {
            currentPage = parseInt(page);
        }
    }

    function updateURL() {
        const params = new URLSearchParams();

        if (selectedTags.length > 0) {
            params.set('tags', selectedTags.join(','));
        }
        if (currentPage !== 1) params.set('page', currentPage);

        const newURL = params.toString()
            ? `${window.location.pathname}?${params}`
            : window.location.pathname;

        window.history.replaceState({}, '', newURL);
    }

    function handleFilter(e) {
        const clickedTag = e.target.dataset.tag;

        // Toggle the clicked tag
        const tagIndex = selectedTags.indexOf(clickedTag);
        if (tagIndex > -1) {
            selectedTags.splice(tagIndex, 1);
        } else {
            selectedTags.push(clickedTag);
        }

        currentPage = 1;
        updateActiveFilters();
        applyFilters();
    }

    function updateActiveFilters() {
        filterBtns.forEach(btn => {
            const tag = btn.dataset.tag;
            if (selectedTags.includes(tag)) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    function applyFilters() {
        // Filter posts
        filteredPosts = allPosts.filter(post => {
            const postTags = post.dataset.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '');

            // If no tags selected, show all posts
            if (selectedTags.length === 0) {
                return true;
            }

            // Tag filter with AND logic - post must have ALL selected tags
            return selectedTags.every(selectedTag => postTags.includes(selectedTag));
        });

        // Always sort by latest first (date-desc)
        filteredPosts.sort((a, b) => {
            return new Date(b.dataset.date) - new Date(a.dataset.date);
        });

        // Update display
        renderPosts();
        renderPagination();
        updateURL();
    }

    function renderPosts() {
        // Hide all posts first
        allPosts.forEach(post => {
            post.classList.add('hidden');
            post.style.display = 'none';
        });

        // Show no results if needed
        if (filteredPosts.length === 0) {
            noResults.style.display = 'block';
            return;
        } else {
            noResults.style.display = 'none';
        }

        // Calculate pagination
        const startIndex = (currentPage - 1) * POSTS_PER_PAGE;
        const endIndex = startIndex + POSTS_PER_PAGE;
        const postsToShow = filteredPosts.slice(startIndex, endIndex);

        // Show current page posts
        postsToShow.forEach(post => {
            post.classList.remove('hidden');
            post.style.display = 'block';
        });

        // Update pagination info
        const totalPosts = filteredPosts.length;
        const showingStart = Math.min(startIndex + 1, totalPosts);
        const showingEnd = Math.min(endIndex, totalPosts);
        paginationInfo.textContent = `Showing ${showingStart}-${showingEnd} of ${totalPosts} transmissions`;
    }

    function renderPagination() {
        const totalPages = Math.ceil(filteredPosts.length / POSTS_PER_PAGE);

        if (totalPages <= 1) {
            pagination.innerHTML = '';
            return;
        }

        let paginationHTML = '';

        // Previous button
        paginationHTML += `
            <button onclick="changePage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left"></i>
            </button>
        `;

        // Page numbers
        const maxVisiblePages = 5;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

        if (endPage - startPage + 1 < maxVisiblePages) {
            startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }

        if (startPage > 1) {
            paginationHTML += '<button onclick="changePage(1)">1</button>';
            if (startPage > 2) {
                paginationHTML += '<button disabled>...</button>';
            }
        }

        for (let i = startPage; i <= endPage; i++) {
            paginationHTML += `
                <button onclick="changePage(${i})" ${i === currentPage ? 'class="active"' : ''}>
                    ${i}
                </button>
            `;
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) {
                paginationHTML += '<button disabled>...</button>';
            }
            paginationHTML += `<button onclick="changePage(${totalPages})">${totalPages}</button>`;
        }

        // Next button
        paginationHTML += `
            <button onclick="changePage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>
                <i class="fas fa-chevron-right"></i>
            </button>
        `;

        pagination.innerHTML = paginationHTML;
    }

    // Global function for pagination
    window.changePage = function(page) {
        const totalPages = Math.ceil(filteredPosts.length / POSTS_PER_PAGE);
        if (page >= 1 && page <= totalPages) {
            currentPage = page;
            renderPosts();
            renderPagination();
            updateURL();

            // Scroll to top smoothly
            document.querySelector('.tutorials-header').scrollIntoView({
                behavior: 'smooth'
            });
        }
    };
});