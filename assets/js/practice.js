document.addEventListener('DOMContentLoaded', function () {
    const cards = document.querySelectorAll('.practice-card[data-storage-key]');

    cards.forEach(function (card) {
        const total = Number(card.dataset.total) || 0;
        const statusElement = card.querySelector('.practice-card-status');
        const progressBar = card.querySelector('.practice-card-progress span');
        const cta = card.querySelector('.practice-card-cta');
        let saved;

        try {
            saved = JSON.parse(window.localStorage.getItem(card.dataset.storageKey));
        } catch (error) {
            saved = null;
        }

        if (!saved || !Array.isArray(saved.answers) || saved.answers.length === 0) return;

        const answered = Math.min(saved.answers.length, total);
        const completed = Boolean(saved.completed);
        const bestScore = Math.min(total, Math.max(0, Number(saved.bestScore) || Number(saved.score) || 0));
        const percent = completed ? 100 : Math.round((answered / total) * 100);

        progressBar.style.width = `${percent}%`;
        card.classList.toggle('is-complete', completed);
        card.classList.toggle('is-progress', !completed);

        if (completed) {
            statusElement.innerHTML = `<i class="fas fa-circle-check"></i> Complete · Best ${bestScore}/${total}`;
            cta.childNodes[0].textContent = 'Run again ';
        } else {
            statusElement.textContent = `${answered}/${total} complete`;
            cta.childNodes[0].textContent = 'Continue ';
        }
    });
});
