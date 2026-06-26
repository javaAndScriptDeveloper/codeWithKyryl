document.addEventListener('DOMContentLoaded', function () {
    const dataEl = document.getElementById('quiz-data');
    const root = document.getElementById('quiz-root');
    if (!dataEl || !root) return;

    const quiz = JSON.parse(dataEl.textContent);
    const questions = quiz.questions || [];
    if (questions.length === 0) return;

    // DOM
    const counterEl = document.getElementById('quiz-counter');
    const scoreEl = document.getElementById('quiz-score');
    const progressBar = document.getElementById('quiz-progress-bar');
    const progressEl = root.querySelector('.quiz-progress');
    const questionEl = document.getElementById('quiz-question');
    const controlsEl = document.getElementById('quiz-controls');
    const resultEl = document.getElementById('quiz-result');

    // State
    let current = 0;
    let picks = [];          // indices picked for the current question
    let answered = false;    // current question locked
    let score = 0;
    let results = [];        // per-question: { picks, correct }

    init();

    function init() {
        questionEl.addEventListener('click', onQuestionClick);
        controlsEl.addEventListener('click', onControlsClick);
        resultEl.addEventListener('click', onResultClick);
        document.addEventListener('keydown', onKeydown);
        renderQuestion();
    }

    // ---- helpers ----------------------------------------------------------
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function correctSet(q) {
        if (q.type === 'multi') return q.correctIndexes || [];
        return [q.correctIndex];
    }

    function isMulti(q) {
        return q.type === 'multi';
    }

    function sameSet(a, b) {
        if (a.length !== b.length) return false;
        const sa = [...a].sort();
        const sb = [...b].sort();
        return sa.every((v, i) => v === sb[i]);
    }

    // ---- rendering --------------------------------------------------------
    function renderQuestion() {
        const q = questions[current];
        picks = [];
        answered = false;

        counterEl.textContent = `Question ${current + 1} of ${questions.length}`;
        scoreEl.textContent = `Score: ${score}`;
        updateProgress();

        const typeLabel = isMulti(q)
            ? 'Select all that apply'
            : (q.type === 'boolean' ? 'True or false' : 'Pick one');

        let html = `<div class="quiz-qhead">
                <span class="quiz-qtype">${escapeHtml(typeLabel)}</span>
            </div>
            <p class="quiz-qtext">${escapeHtml(q.question)}</p>
            <div class="quiz-options" role="${isMulti(q) ? 'group' : 'radiogroup'}">`;

        q.options.forEach((opt, i) => {
            html += `<button type="button" class="quiz-option" data-index="${i}"
                role="${isMulti(q) ? 'checkbox' : 'radio'}" aria-checked="false">
                <span class="quiz-option-key">${i + 1}</span>
                <span class="quiz-option-text">${escapeHtml(opt)}</span>
            </button>`;
        });

        html += `</div>
            <div class="quiz-explanation" id="quiz-explanation" hidden aria-live="polite"></div>`;

        questionEl.innerHTML = html;
        renderControls();
    }

    function renderControls() {
        const q = questions[current];
        if (answered) {
            const isLast = current === questions.length - 1;
            controlsEl.innerHTML = `<button type="button" class="btn-primary" data-action="next">
                ${isLast ? 'See results' : 'Next question'} <i class="fas fa-arrow-right"></i>
            </button>`;
        } else if (isMulti(q)) {
            controlsEl.innerHTML = `<button type="button" class="btn-primary" data-action="check" disabled>
                Check answer
            </button>`;
        } else {
            controlsEl.innerHTML = '';
        }
    }

    function updateProgress() {
        const pct = Math.round((current / questions.length) * 100);
        progressBar.style.width = pct + '%';
        if (progressEl) progressEl.setAttribute('aria-valuenow', String(pct));
    }

    // ---- interaction ------------------------------------------------------
    function onQuestionClick(e) {
        const btn = e.target.closest('.quiz-option');
        if (!btn || answered) return;
        const idx = parseInt(btn.dataset.index, 10);
        const q = questions[current];

        if (isMulti(q)) {
            togglePick(idx, btn);
        } else {
            picks = [idx];
            lockAnswer();
        }
    }

    function togglePick(idx, btn) {
        const pos = picks.indexOf(idx);
        if (pos > -1) {
            picks.splice(pos, 1);
            btn.classList.remove('selected');
            btn.setAttribute('aria-checked', 'false');
        } else {
            picks.push(idx);
            btn.classList.add('selected');
            btn.setAttribute('aria-checked', 'true');
        }
        const checkBtn = controlsEl.querySelector('[data-action="check"]');
        if (checkBtn) checkBtn.disabled = picks.length === 0;
    }

    function onControlsClick(e) {
        const action = e.target.closest('[data-action]');
        if (!action) return;
        if (action.dataset.action === 'check') lockAnswer();
        else if (action.dataset.action === 'next') next();
    }

    function lockAnswer() {
        if (answered) return;
        const q = questions[current];
        const correct = correctSet(q);
        const isCorrect = sameSet(picks, correct);

        answered = true;
        if (isCorrect) score++;
        results.push({ picks: [...picks], correct: isCorrect });

        const optionEls = questionEl.querySelectorAll('.quiz-option');
        optionEls.forEach((el) => {
            const i = parseInt(el.dataset.index, 10);
            el.disabled = true;
            el.setAttribute('aria-disabled', 'true');
            if (correct.includes(i)) el.classList.add('correct');
            else if (picks.includes(i)) el.classList.add('incorrect');
        });

        const expEl = document.getElementById('quiz-explanation');
        expEl.hidden = false;
        expEl.innerHTML = `<span class="quiz-verdict ${isCorrect ? 'is-correct' : 'is-wrong'}">
                <i class="fas ${isCorrect ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                ${isCorrect ? 'Correct' : 'Not quite'}
            </span>
            <p>${escapeHtml(q.explanation)}</p>`;

        scoreEl.textContent = `Score: ${score}`;
        renderControls();
        const nextBtn = controlsEl.querySelector('[data-action="next"]');
        if (nextBtn) nextBtn.focus();
    }

    function next() {
        current++;
        if (current >= questions.length) {
            renderResult();
        } else {
            renderQuestion();
        }
    }

    // ---- result -----------------------------------------------------------
    function renderResult() {
        progressBar.style.width = '100%';
        if (progressEl) progressEl.setAttribute('aria-valuenow', '100');
        questionEl.hidden = true;
        controlsEl.hidden = true;
        counterEl.textContent = 'Complete';
        scoreEl.textContent = '';

        const total = questions.length;
        const pct = Math.round((score / total) * 100);
        let verdict;
        if (pct >= 80) verdict = 'Excellent — you know your Kafka.';
        else if (pct >= 50) verdict = 'Solid, but a few gaps to review.';
        else verdict = 'Worth another pass — check the explanations.';

        let html = `<div class="quiz-result-card">
            <div class="quiz-result-ring" style="--pct:${pct}">
                <span class="quiz-result-score">${score}<small>/${total}</small></span>
            </div>
            <p class="quiz-result-pct">${pct}%</p>
            <p class="quiz-result-verdict">${escapeHtml(verdict)}</p>
            <div class="quiz-result-actions">
                <button type="button" class="btn-primary" data-action="retry">
                    <i class="fas fa-rotate-right"></i> Try again
                </button>
                <button type="button" class="btn-secondary" data-action="review">
                    <i class="fas fa-list-check"></i> Review answers
                </button>
            </div>
        </div>
        <div id="quiz-review" hidden></div>`;

        resultEl.innerHTML = html;
        resultEl.hidden = false;
    }

    function onResultClick(e) {
        const action = e.target.closest('[data-action]');
        if (!action) return;
        if (action.dataset.action === 'retry') retry();
        else if (action.dataset.action === 'review') toggleReview(action);
    }

    function retry() {
        current = 0;
        picks = [];
        answered = false;
        score = 0;
        results = [];
        questionEl.hidden = false;
        controlsEl.hidden = false;
        resultEl.hidden = true;
        resultEl.innerHTML = '';
        renderQuestion();
        root.scrollIntoView({ behavior: 'smooth' });
    }

    function toggleReview(btn) {
        const reviewEl = document.getElementById('quiz-review');
        if (!reviewEl) return;
        if (!reviewEl.hidden) {
            reviewEl.hidden = true;
            reviewEl.innerHTML = '';
            return;
        }
        let html = '';
        questions.forEach((q, qi) => {
            const r = results[qi];
            const correct = correctSet(q);
            html += `<div class="quiz-review-item ${r && r.correct ? 'is-correct' : 'is-wrong'}">
                <p class="quiz-review-q">
                    <i class="fas ${r && r.correct ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                    ${qi + 1}. ${escapeHtml(q.question)}
                </p>
                <ul class="quiz-review-opts">`;
            q.options.forEach((opt, oi) => {
                const isAns = correct.includes(oi);
                const wasPicked = r && r.picks.includes(oi);
                let tag = '';
                if (isAns) tag = '<span class="quiz-review-tag correct">correct</span>';
                else if (wasPicked) tag = '<span class="quiz-review-tag wrong">your pick</span>';
                html += `<li class="${isAns ? 'opt-correct' : ''} ${wasPicked && !isAns ? 'opt-wrong' : ''}">
                    ${escapeHtml(opt)} ${tag}
                </li>`;
            });
            html += `</ul><p class="quiz-review-exp">${escapeHtml(q.explanation)}</p></div>`;
        });
        reviewEl.innerHTML = html;
        reviewEl.hidden = false;
        reviewEl.scrollIntoView({ behavior: 'smooth' });
    }

    // ---- keyboard ---------------------------------------------------------
    function onKeydown(e) {
        if (resultEl && !resultEl.hidden) return;
        const q = questions[current];

        // number keys select / toggle options
        if (/^[1-9]$/.test(e.key)) {
            const idx = parseInt(e.key, 10) - 1;
            if (idx < q.options.length && !answered) {
                const btn = questionEl.querySelector(`.quiz-option[data-index="${idx}"]`);
                if (btn) {
                    if (isMulti(q)) togglePick(idx, btn);
                    else { picks = [idx]; lockAnswer(); }
                }
            }
            return;
        }

        if (e.key === 'Enter' || e.key === 'ArrowRight') {
            if (answered) {
                e.preventDefault();
                next();
            } else if (isMulti(q) && picks.length > 0) {
                e.preventDefault();
                lockAnswer();
            }
        }
    }
});
