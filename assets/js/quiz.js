document.addEventListener('DOMContentLoaded', function () {
    const dataElement = document.getElementById('quiz-data');
    const root = document.getElementById('quiz-root');
    if (!dataElement || !root) return;

    const practice = JSON.parse(dataElement.textContent);
    const questions = practice.questions || [];
    if (questions.length === 0) return;

    const format = root.dataset.format || practice.format || 'quick-quiz';
    const slug = root.dataset.slug || practice.slug || 'practice';
    const storageKey = `codewithkyryl.practice.${slug}.v1`;
    const vocabulary = formatVocabulary(format);

    const counterElement = document.getElementById('quiz-counter');
    const scoreElement = document.getElementById('quiz-score');
    const progressBar = document.getElementById('quiz-progress-bar');
    const progressElement = root.querySelector('.quiz-progress');
    const questionElement = document.getElementById('quiz-question');
    const controlsElement = document.getElementById('quiz-controls');
    const resultElement = document.getElementById('quiz-result');

    let current = 0;
    let picks = [];
    let answered = false;
    let score = 0;
    let results = [];
    let bestScore = 0;

    init();

    function init() {
        restoreProgress();
        questionElement.addEventListener('click', onQuestionClick);
        controlsElement.addEventListener('click', onControlsClick);
        resultElement.addEventListener('click', onResultClick);
        document.addEventListener('keydown', onKeydown);

        if (current >= questions.length) renderResult();
        else renderQuestion();

        track('practice_started', { slug: slug, format: format });
    }

    function formatVocabulary(value) {
        if (value === 'scenario-drill') {
            return {
                singular: 'scenario', plural: 'scenarios', prefix: 'SCN',
                score: 'Decisions', correct: 'Sound decision', wrong: 'Review this decision'
            };
        }
        if (value === 'production-lab') {
            return {
                singular: 'incident', plural: 'incidents', prefix: 'INC',
                score: 'Stabilized', correct: 'Incident stabilized', wrong: 'Unsafe response'
            };
        }
        return {
            singular: 'question', plural: 'questions', prefix: 'Q',
            score: 'Score', correct: 'Correct', wrong: 'Not quite'
        };
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }

    function capitalize(value) {
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    function correctSet(question) {
        if (question.type === 'multi') return question.correctIndexes || [];
        return [question.correctIndex];
    }

    function isMulti(question) {
        return question.type === 'multi';
    }

    function sameSet(first, second) {
        if (first.length !== second.length) return false;
        const sortedFirst = [...first].sort();
        const sortedSecond = [...second].sort();
        return sortedFirst.every((value, index) => value === sortedSecond[index]);
    }

    function restoreProgress() {
        try {
            const saved = JSON.parse(window.localStorage.getItem(storageKey));
            if (!saved) return;
            bestScore = Math.max(0, Math.min(questions.length, Number(saved.bestScore) || 0));
            if (saved.completed || !Array.isArray(saved.answers)) return;

            results = saved.answers.slice(0, questions.length).filter(function (result) {
                return result && Array.isArray(result.picks) && typeof result.correct === 'boolean';
            });
            score = results.filter(function (result) { return result.correct; }).length;
            current = results.length;
        } catch (error) {
            // Storage is optional; a fresh in-memory run still works.
        }
    }

    function saveProgress(completed) {
        bestScore = completed ? Math.max(bestScore, score) : bestScore;
        try {
            window.localStorage.setItem(storageKey, JSON.stringify({
                current: current,
                score: score,
                answers: results,
                completed: completed,
                bestScore: bestScore
            }));
        } catch (error) {
            // Storage is optional; keep the current page session usable.
        }
    }

    function renderQuestion() {
        const question = questions[current];
        picks = [];
        answered = false;

        counterElement.textContent = `${capitalize(vocabulary.singular)} ${current + 1} of ${questions.length}`;
        scoreElement.textContent = `${vocabulary.score}: ${score}`;
        updateProgress();

        let typeLabel;
        if (isMulti(question)) typeLabel = 'Select all that apply';
        else if (question.type === 'boolean') typeLabel = 'True or false';
        else typeLabel = format === 'quick-quiz' ? 'Pick one' : 'Choose a response';

        const sequence = `${vocabulary.prefix}-${String(current + 1).padStart(2, '0')}`;
        let html = `<div class="quiz-qhead">
                <span class="quiz-qsequence">${escapeHtml(sequence)}</span>
                <span class="quiz-qtype">${escapeHtml(typeLabel)}</span>
            </div>
            <p class="quiz-qtext">${escapeHtml(question.question)}</p>
            <div class="quiz-options" role="group" aria-label="Answer choices">`;

        const order = window.optionOrder ? window.optionOrder(question, Math.random) : question.options.map(function (_, index) { return index; });
        order.forEach(function (index, position) {
            html += `<button type="button" class="quiz-option" data-index="${index}" aria-pressed="false">
                <span class="quiz-option-key">${position + 1}</span>
                <span class="quiz-option-text">${escapeHtml(question.options[index])}</span>
            </button>`;
        });

        html += `</div><div class="quiz-explanation" id="quiz-explanation" hidden aria-live="polite"></div>`;
        questionElement.innerHTML = html;
        renderControls();
    }

    function renderControls() {
        const question = questions[current];
        if (answered) {
            const isLast = current === questions.length - 1;
            controlsElement.innerHTML = `<button type="button" class="btn-primary" data-action="next">
                ${isLast ? 'Open report' : `Next ${vocabulary.singular}`} <i class="fas fa-arrow-right"></i>
            </button>`;
        } else if (isMulti(question)) {
            controlsElement.innerHTML = '<button type="button" class="btn-primary" data-action="check" disabled>Commit decision</button>';
        } else {
            controlsElement.innerHTML = '';
        }
    }

    function updateProgress() {
        const percent = Math.round((current / questions.length) * 100);
        progressBar.style.width = `${percent}%`;
        if (progressElement) progressElement.setAttribute('aria-valuenow', String(percent));
    }

    function onQuestionClick(event) {
        const button = event.target.closest('.quiz-option');
        if (!button || answered) return;
        const index = Number(button.dataset.index);
        const question = questions[current];

        if (isMulti(question)) togglePick(index, button);
        else {
            picks = [index];
            button.setAttribute('aria-pressed', 'true');
            lockAnswer();
        }
    }

    function togglePick(index, button) {
        const position = picks.indexOf(index);
        if (position > -1) {
            picks.splice(position, 1);
            button.classList.remove('selected');
            button.setAttribute('aria-pressed', 'false');
        } else {
            picks.push(index);
            button.classList.add('selected');
            button.setAttribute('aria-pressed', 'true');
        }
        const checkButton = controlsElement.querySelector('[data-action="check"]');
        if (checkButton) checkButton.disabled = picks.length === 0;
    }

    function onControlsClick(event) {
        const action = event.target.closest('[data-action]');
        if (!action) return;
        if (action.dataset.action === 'check') lockAnswer();
        if (action.dataset.action === 'next') next();
    }

    function lockAnswer() {
        if (answered) return;
        const question = questions[current];
        const correct = correctSet(question);
        const isCorrect = sameSet(picks, correct);

        answered = true;
        if (isCorrect) score += 1;
        results.push({ picks: [...picks], correct: isCorrect });

        questionElement.querySelectorAll('.quiz-option').forEach(function (option) {
            const index = Number(option.dataset.index);
            option.disabled = true;
            option.setAttribute('aria-disabled', 'true');
            if (correct.includes(index)) option.classList.add('correct');
            else if (picks.includes(index)) option.classList.add('incorrect');
        });

        const explanationElement = document.getElementById('quiz-explanation');
        explanationElement.hidden = false;
        explanationElement.innerHTML = `<span class="quiz-verdict ${isCorrect ? 'is-correct' : 'is-wrong'}">
                <i class="fas ${isCorrect ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                ${escapeHtml(isCorrect ? vocabulary.correct : vocabulary.wrong)}
            </span>
            ${format === 'quick-quiz' ? '' : '<span class="quiz-consequence-label">Operational consequence</span>'}
            <p>${escapeHtml(question.explanation)}</p>`;

        scoreElement.textContent = `${vocabulary.score}: ${score}`;
        renderControls();
        saveProgress(false);
        track('practice_answered', {
            slug: slug, format: format, item: current + 1, correct: isCorrect
        });

        const nextButton = controlsElement.querySelector('[data-action="next"]');
        if (nextButton) nextButton.focus();
    }

    function next() {
        current += 1;
        if (current >= questions.length) renderResult();
        else {
            saveProgress(false);
            renderQuestion();
        }
    }

    function renderResult() {
        progressBar.style.width = '100%';
        if (progressElement) progressElement.setAttribute('aria-valuenow', '100');
        questionElement.hidden = true;
        controlsElement.hidden = true;
        controlsElement.innerHTML = '';
        counterElement.textContent = 'Complete';
        scoreElement.textContent = '';

        const total = questions.length;
        const percent = Math.round((score / total) * 100);
        let verdict;
        if (format === 'production-lab') {
            if (percent >= 80) verdict = 'Production ready — your reliability calls held up.';
            else if (percent >= 50) verdict = 'Shift survived, but the report exposes risky decisions.';
            else verdict = 'The system needs another incident review before the next shift.';
        } else if (format === 'scenario-drill') {
            if (percent >= 80) verdict = 'Strong predictions — the Kafka behavior is becoming intuitive.';
            else if (percent >= 50) verdict = 'Solid base, with several configuration gaps to revisit.';
            else verdict = 'Re-run the scenarios after reviewing their explanations.';
        } else if (percent >= 80) verdict = 'Excellent — the Kafka fundamentals are in place.';
        else if (percent >= 50) verdict = 'Solid, but a few fundamentals need review.';
        else verdict = 'Worth another pass — use the explanations to rebuild the model.';

        saveProgress(true);
        track('practice_completed', { slug: slug, format: format, score: score, total: total });

        resultElement.innerHTML = `<div class="quiz-result-card">
            <span class="quiz-result-format">${escapeHtml(root.dataset.formatLabel || practice.format_label || 'Practice report')}</span>
            <div class="quiz-result-ring" style="--pct:${percent}">
                <span class="quiz-result-score">${score}<small>/${total}</small></span>
            </div>
            <p class="quiz-result-pct">${percent}%</p>
            <p class="quiz-result-verdict">${escapeHtml(verdict)}</p>
            <div class="quiz-result-actions">
                <button type="button" class="btn-primary" data-action="retry"><i class="fas fa-rotate-right"></i> Run again</button>
                <button type="button" class="btn-secondary" data-action="review"><i class="fas fa-list-check"></i> Review ${escapeHtml(vocabulary.plural)}</button>
                <a class="btn-secondary" href="${practiceUrl()}"><i class="fas fa-grip"></i> All practice</a>
            </div>
            <div class="quiz-share" id="quiz-share"></div>
        </div><div id="quiz-review" hidden></div>`;

        resultElement.hidden = false;
        mountShareCard(verdict);
        root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function mountShareCard(verdict) {
        const container = document.getElementById('quiz-share');
        if (!container || !window.ShareCard) return;
        const label = [root.dataset.formatLabel || practice.format_label, practice.difficulty].filter(Boolean).join(' · ');
        window.ShareCard.mount(container, {
            slug: slug,
            title: practice.title,
            label: label,
            score: score,
            total: questions.length,
            verdict: verdict,
            url: canonicalUrl()
        }, { track: track });
    }

    function canonicalUrl() {
        const canonical = document.querySelector('link[rel="canonical"]');
        return (canonical && canonical.href) || window.location.href;
    }

    function practiceUrl() {
        const back = document.querySelector('.quiz-back');
        return (back && back.getAttribute('href')) || '/practice/';
    }

    function onResultClick(event) {
        const action = event.target.closest('[data-action]');
        if (!action) return;
        if (action.dataset.action === 'retry') retry();
        if (action.dataset.action === 'review') toggleReview();
    }

    function retry() {
        current = 0;
        picks = [];
        answered = false;
        score = 0;
        results = [];
        questionElement.hidden = false;
        controlsElement.hidden = false;
        resultElement.hidden = true;
        resultElement.innerHTML = '';
        saveProgress(false);
        track('practice_restarted', { slug: slug, format: format, best_score: bestScore });
        renderQuestion();
        root.scrollIntoView({ behavior: 'smooth' });
    }

    function toggleReview() {
        const reviewElement = document.getElementById('quiz-review');
        if (!reviewElement) return;
        if (!reviewElement.hidden) {
            reviewElement.hidden = true;
            reviewElement.innerHTML = '';
            return;
        }

        reviewElement.innerHTML = questions.map(function (question, questionIndex) {
            const result = results[questionIndex];
            const correct = correctSet(question);
            const options = question.options.map(function (option, optionIndex) {
                const isAnswer = correct.includes(optionIndex);
                const wasPicked = result && result.picks.includes(optionIndex);
                let tag = '';
                if (isAnswer) tag = '<span class="quiz-review-tag correct">correct</span>';
                else if (wasPicked) tag = '<span class="quiz-review-tag wrong">your pick</span>';
                return `<li class="${isAnswer ? 'opt-correct' : ''} ${wasPicked && !isAnswer ? 'opt-wrong' : ''}">${escapeHtml(option)} ${tag}</li>`;
            }).join('');
            return `<div class="quiz-review-item ${result && result.correct ? 'is-correct' : 'is-wrong'}">
                <p class="quiz-review-q"><i class="fas ${result && result.correct ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                ${capitalize(vocabulary.singular)} ${questionIndex + 1}. ${escapeHtml(question.question)}</p>
                <ul class="quiz-review-opts">${options}</ul>
                <p class="quiz-review-exp">${escapeHtml(question.explanation)}</p>
            </div>`;
        }).join('');
        reviewElement.hidden = false;
        reviewElement.scrollIntoView({ behavior: 'smooth' });
    }

    function onKeydown(event) {
        if (resultElement && !resultElement.hidden) return;
        const question = questions[current];
        if (!question) return;

        if (/^[1-9]$/.test(event.key)) {
            const position = Number(event.key) - 1;
            if (position < question.options.length && !answered) {
                // Number keys follow the on-screen order; data-index holds the authored index.
                const button = questionElement.querySelectorAll('.quiz-option')[position];
                if (button) {
                    const index = Number(button.dataset.index);
                    if (isMulti(question)) togglePick(index, button);
                    else {
                        picks = [index];
                        button.setAttribute('aria-pressed', 'true');
                        lockAnswer();
                    }
                }
            }
            return;
        }

        if (event.key === 'Enter' || event.key === 'ArrowRight') {
            if (answered) {
                event.preventDefault();
                next();
            } else if (isMulti(question) && picks.length > 0) {
                event.preventDefault();
                lockAnswer();
            }
        }
    }

    function track(eventName, properties) {
        if (window.umami && typeof window.umami.track === 'function') {
            window.umami.track(eventName, properties);
        }
    }
});
