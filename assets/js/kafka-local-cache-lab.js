(function () {
    'use strict';

    const STORAGE_KEY = 'codewithkyryl.kafka-local-cache-lab.v1';

    const incidents = [
        {
            id: 'INC-001',
            severity: 'SEV-2',
            topic: 'Consumer groups',
            title: 'Three healthy pods, three different caches',
            brief: 'A configuration update reaches the cluster, but requests return different feature flags depending on which pod handles them.',
            evidence: [
                'The topic has three partitions and every record is keyed.',
                'Pod A holds only keys from partition 0; Pod B holds partition 1; Pod C holds partition 2.',
                'All consumers report healthy and lag is near zero.'
            ],
            config: 'spring:\n  kafka:\n    consumer:\n      group-id: local-cache-prod\n\nreplicas: 3',
            question: 'What change makes every pod receive the complete configuration?',
            options: [
                'Increase the topic to nine partitions so every pod gets more work',
                'Give every pod a distinct consumer group ID',
                'Enable producer idempotence and keep the shared group',
                'Set listener concurrency to three in every pod'
            ],
            correctIndex: 1,
            explanation: 'A consumer group is a load-balancing boundary. Members of one group split partitions, so a shared group deliberately gives each pod only part of the topic. A unique group per pod gives every pod an independent subscription and the complete log.',
            effect: 'Each pod now consumes partitions P0, P1, and P2 into its own local cache.',
            topologyBefore: {
                label: 'Current assignment: shared group',
                nodes: [
                    { icon: 'fa-database', label: 'Kafka', detail: 'P0 · P1 · P2', state: 'source' },
                    { icon: 'fa-cube', label: 'Pod A', detail: 'P0 only', state: 'danger' },
                    { icon: 'fa-cube', label: 'Pod B', detail: 'P1 only', state: 'danger' },
                    { icon: 'fa-cube', label: 'Pod C', detail: 'P2 only', state: 'danger' }
                ]
            },
            topologyAfter: {
                label: 'Resolved: one group per pod',
                nodes: [
                    { icon: 'fa-database', label: 'Kafka', detail: 'P0 · P1 · P2', state: 'source' },
                    { icon: 'fa-cube', label: 'Pod A', detail: 'P0 · P1 · P2', state: 'success' },
                    { icon: 'fa-cube', label: 'Pod B', detail: 'P0 · P1 · P2', state: 'success' },
                    { icon: 'fa-cube', label: 'Pod C', detail: 'P0 · P1 · P2', state: 'success' }
                ]
            }
        },
        {
            id: 'INC-002',
            severity: 'SEV-2',
            topic: 'Startup replay',
            title: 'The replacement pod starts with an empty cache',
            brief: 'A pod is replaced during a routine deployment. It joins with a new group ID, becomes healthy, but has no configuration until somebody changes a value.',
            evidence: [
                'The compacted topic already contains the current value for every key.',
                'The new group has no committed offsets.',
                'Only records produced after the restart appear in the local cache.'
            ],
            config: 'consumer:\n  group-id: local-cache-${POD_UID}\n  auto-offset-reset: latest\n\ntopic.cleanup.policy: compact',
            question: 'How should a brand-new pod reconstruct the current state?',
            options: [
                'Use auto.offset.reset=earliest and replay the compacted topic',
                'Reuse the old pod group ID and wait for Kafka to restore its heap',
                'Keep latest, but double the consumer fetch size',
                'Ask the producer to republish every key after each deployment'
            ],
            correctIndex: 0,
            explanation: 'A new consumer group has no offset to resume from. With latest it begins at the end and misses the state already in the log. Earliest lets it replay the compacted topic and rebuild the materialized cache from retained records.',
            effect: 'The new pod replays retained records from offset zero and reconstructs the current key set.',
            topologyBefore: {
                label: 'Current startup: latest offset',
                nodes: [
                    { icon: 'fa-box-archive', label: 'Retained state', detail: 'Offsets 0—847', state: 'muted' },
                    { icon: 'fa-location-crosshairs', label: 'New cursor', detail: 'Offset 848', state: 'danger' },
                    { icon: 'fa-cube', label: 'New pod', detail: 'Cache: empty', state: 'danger' }
                ]
            },
            topologyAfter: {
                label: 'Resolved: replay from earliest',
                nodes: [
                    { icon: 'fa-box-archive', label: 'Retained state', detail: 'Offsets 0—847', state: 'source' },
                    { icon: 'fa-arrow-right-arrow-left', label: 'Replay', detail: '0 → 848', state: 'success' },
                    { icon: 'fa-cube', label: 'New pod', detail: 'Cache rebuilt', state: 'success' }
                ]
            }
        },
        {
            id: 'INC-003',
            severity: 'SEV-1',
            topic: 'Readiness',
            title: 'Healthy does not mean ready',
            brief: 'The replay fix works, but the deployment sends live traffic to a new pod while it has loaded only 18% of the configuration.',
            evidence: [
                'The process is alive and its HTTP server responds.',
                'Kafka lag falls steadily for several minutes after startup.',
                'Requests for keys not replayed yet fall back to unsafe defaults.'
            ],
            config: 'management.endpoint.health.probes.enabled: true\n\nreadiness:\n  state: UP  # immediately on application start',
            question: 'What is the safe readiness condition?',
            options: [
                'Open readiness when consumer lag reaches zero and keep moving the target',
                'Sleep for a fixed 60 seconds before reporting ready',
                'Capture partition end offsets on assignment and open only after each fixed target is processed',
                'Report ready as soon as the Kafka TCP connection succeeds'
            ],
            correctIndex: 2,
            explanation: 'Capture a fixed end offset for every assigned partition at startup, then report ready only after processing reaches those targets. A fixed snapshot finishes even while new writes continue; moving “lag zero” can create an endless startup under continuous traffic.',
            effect: 'The platform withholds traffic until the startup snapshot is fully materialized.',
            topologyBefore: {
                label: 'Current rollout: traffic arrives during replay',
                nodes: [
                    { icon: 'fa-users', label: 'Traffic', detail: 'Routing now', state: 'danger' },
                    { icon: 'fa-cube', label: 'New pod', detail: '18% replayed', state: 'danger' },
                    { icon: 'fa-heart-pulse', label: 'Readiness', detail: 'UP too early', state: 'danger' }
                ]
            },
            topologyAfter: {
                label: 'Resolved: fixed startup targets',
                nodes: [
                    { icon: 'fa-list-ol', label: 'Targets', detail: 'P0: 184 · P1: 221', state: 'source' },
                    { icon: 'fa-cube', label: 'New pod', detail: 'Targets reached', state: 'success' },
                    { icon: 'fa-heart-pulse', label: 'Readiness', detail: 'UP safely', state: 'success' }
                ]
            }
        },
        {
            id: 'INC-004',
            severity: 'SEV-2',
            topic: 'Compaction and deletion',
            title: 'Deleted configuration returns after a restart',
            brief: 'An operator removes a routing rule. Live pods evict it, but a pod restarted the next morning rebuilds the supposedly deleted rule.',
            evidence: [
                'The producer published {"deleted": true} as a normal non-null value.',
                'The topic uses cleanup.policy=compact.',
                'During replay, the consumer treats every non-null value as an upsert.'
            ],
            config: 'ProducerRecord(\n  topic = "service-config",\n  key   = "route.eu-west",\n  value = "{\\"deleted\\":true}"\n)',
            question: 'What record represents deletion in a compacted topic?',
            options: [
                'A record with a null key and the previous value',
                'A record with the same key and an empty JSON object',
                'A record with the same key and a null value (a tombstone)',
                'No record; delete the old Kafka segment manually'
            ],
            correctIndex: 2,
            explanation: 'A tombstone is a record with the target key and a null value. Consumers interpret it as an eviction, and Kafka compaction can eventually remove both the previous value and the tombstone after the configured retention window.',
            effect: 'Every live pod evicts the key, and future replays no longer reconstruct the deleted rule.',
            topologyBefore: {
                label: 'Current log: deletion stored as data',
                nodes: [
                    { icon: 'fa-file-code', label: 'Kafka record', detail: 'value: {deleted:true}', state: 'danger' },
                    { icon: 'fa-rotate', label: 'Replay', detail: 'Non-null = upsert', state: 'danger' },
                    { icon: 'fa-cube', label: 'Restarted pod', detail: 'Rule restored', state: 'danger' }
                ]
            },
            topologyAfter: {
                label: 'Resolved: keyed tombstone',
                nodes: [
                    { icon: 'fa-file-circle-xmark', label: 'Tombstone', detail: 'key set · value null', state: 'source' },
                    { icon: 'fa-trash-can', label: 'Consumer', detail: 'Evict key', state: 'success' },
                    { icon: 'fa-cube', label: 'Restarted pod', detail: 'Rule absent', state: 'success' }
                ]
            }
        }
    ];

    const root = document.getElementById('incident-lab');
    if (!root) return;

    const elements = {
        stage: document.getElementById('lab-stage'),
        result: document.getElementById('lab-result'),
        stepLabel: document.getElementById('lab-step-label'),
        score: document.getElementById('lab-score'),
        progress: root.querySelector('.lab-progress'),
        progressBar: document.getElementById('lab-progress-bar'),
        number: document.getElementById('incident-number'),
        severity: document.getElementById('incident-severity'),
        title: document.getElementById('incident-title'),
        brief: document.getElementById('incident-brief'),
        evidence: document.getElementById('incident-evidence'),
        config: document.getElementById('incident-config'),
        topology: document.getElementById('incident-topology'),
        question: document.getElementById('response-question'),
        options: document.getElementById('response-options'),
        feedback: document.getElementById('response-feedback'),
        actions: document.getElementById('response-actions')
    };

    let state = loadState();
    let answered = false;

    if (state.completed) {
        renderResult();
    } else {
        renderIncident(state.current > 0 || state.answers.length > 0);
        if (state.current === 0 && state.answers.length === 0) track('lab_started', { lab: 'kafka_local_cache' });
    }

    elements.options.addEventListener('click', function (event) {
        const option = event.target.closest('[data-option]');
        if (option) answer(Number(option.dataset.option));
    });

    elements.actions.addEventListener('click', function (event) {
        const action = event.target.closest('[data-action]');
        if (action && action.dataset.action === 'next') nextIncident();
    });

    elements.result.addEventListener('click', function (event) {
        const action = event.target.closest('[data-action]');
        if (!action) return;
        if (action.dataset.action === 'retry') restart();
        if (action.dataset.action === 'share') shareResult(action);
    });

    document.addEventListener('keydown', function (event) {
        if (state.completed) return;
        if (/^[1-4]$/.test(event.key) && !answered) answer(Number(event.key) - 1);
        if ((event.key === 'Enter' || event.key === 'ArrowRight') && answered) {
            event.preventDefault();
            nextIncident();
        }
    });

    function initialState(bestScore) {
        return {
            current: 0,
            score: 0,
            answers: [],
            completed: false,
            bestScore: Number.isInteger(bestScore) ? bestScore : 0
        };
    }

    function loadState() {
        try {
            const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
            if (!stored || !Array.isArray(stored.answers)) return initialState();
            if (stored.current < 0 || stored.current >= incidents.length) return initialState(stored.bestScore);
            const restored = {
                current: stored.current,
                score: Math.max(0, Math.min(incidents.length, Number(stored.score) || 0)),
                answers: stored.answers.slice(0, incidents.length),
                completed: Boolean(stored.completed),
                bestScore: Math.max(0, Math.min(incidents.length, Number(stored.bestScore) || 0))
            };
            // An answer is persisted before the user presses "next". On reload,
            // resume at the next unresolved incident instead of allowing a duplicate answer.
            if (!restored.completed && restored.answers.length > restored.current) {
                if (restored.current === incidents.length - 1) {
                    restored.completed = true;
                    restored.bestScore = Math.max(restored.bestScore, restored.score);
                } else {
                    restored.current += 1;
                }
            }
            return restored;
        } catch (error) {
            return initialState();
        }
    }

    function saveState() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            // The lab remains usable for the current page view when storage is unavailable.
        }
    }

    function renderIncident(shouldScroll) {
        const incident = incidents[state.current];
        answered = false;
        elements.stage.hidden = false;
        elements.result.hidden = true;
        elements.stepLabel.textContent = `Incident ${state.current + 1} of ${incidents.length}`;
        elements.score.textContent = `Systems stabilized: ${state.score}`;
        updateProgress((state.current / incidents.length) * 100);

        elements.number.textContent = incident.id;
        elements.severity.textContent = incident.severity;
        elements.title.textContent = incident.title;
        elements.brief.textContent = incident.brief;
        elements.evidence.innerHTML = incident.evidence.map(function (item) {
            return `<li>${escapeHtml(item)}</li>`;
        }).join('');
        elements.config.textContent = incident.config;
        elements.question.textContent = incident.question;
        renderTopology(incident.topologyBefore);

        elements.options.innerHTML = incident.options.map(function (option, index) {
            return `<button type="button" class="response-option" data-option="${index}" aria-pressed="false">
                <span class="response-option-key">${index + 1}</span>
                <span>${escapeHtml(option)}</span>
            </button>`;
        }).join('');
        elements.feedback.hidden = true;
        elements.feedback.innerHTML = '';
        elements.actions.innerHTML = '';
        root.classList.remove('is-answered');
        if (shouldScroll) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function answer(index) {
        if (answered || index < 0 || index >= incidents[state.current].options.length) return;
        answered = true;

        const incident = incidents[state.current];
        const correct = index === incident.correctIndex;
        if (correct) state.score += 1;
        state.answers.push({ incident: incident.id, selected: index, correct: correct, topic: incident.topic });

        elements.options.querySelectorAll('.response-option').forEach(function (option, optionIndex) {
            option.disabled = true;
            option.setAttribute('aria-disabled', 'true');
            if (optionIndex === index) option.setAttribute('aria-pressed', 'true');
            if (optionIndex === incident.correctIndex) option.classList.add('is-correct');
            if (optionIndex === index && !correct) option.classList.add('is-wrong');
        });

        elements.feedback.className = `response-feedback ${correct ? 'is-correct' : 'is-wrong'}`;
        elements.feedback.innerHTML = `<div class="response-verdict">
                <i class="fas ${correct ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                ${correct ? 'Incident stabilized' : 'That would not stabilize the system'}
            </div>
            <p>${escapeHtml(incident.explanation)}</p>
            <div class="response-effect"><strong>System effect:</strong> ${escapeHtml(incident.effect)}</div>`;
        elements.feedback.hidden = false;
        elements.actions.innerHTML = `<button type="button" class="btn-primary" data-action="next">
            ${state.current === incidents.length - 1 ? 'Open incident report' : 'Next incident'} <i class="fas fa-arrow-right"></i>
        </button>`;
        elements.score.textContent = `Systems stabilized: ${state.score}`;
        renderTopology(incident.topologyAfter);
        root.classList.add('is-answered');

        saveState();
        track('lab_answered', {
            lab: 'kafka_local_cache',
            incident: incident.id,
            topic: incident.topic,
            correct: correct
        });

        const nextButton = elements.actions.querySelector('button');
        if (nextButton) nextButton.focus({ preventScroll: true });
    }

    function nextIncident() {
        if (!answered) return;
        if (state.current === incidents.length - 1) {
            state.completed = true;
            state.bestScore = Math.max(state.bestScore, state.score);
            saveState();
            track('lab_completed', {
                lab: 'kafka_local_cache',
                score: state.score,
                total: incidents.length
            });
            renderResult();
            return;
        }
        state.current += 1;
        saveState();
        renderIncident(true);
    }

    function renderTopology(topology) {
        const nodes = topology.nodes.map(function (node, index) {
            const connector = index === 0 ? '' : '<i class="fas fa-arrow-right topology-arrow" aria-hidden="true"></i>';
            return `${connector}<div class="topology-node is-${escapeHtml(node.state)}">
                <i class="fas ${escapeHtml(node.icon)} topology-icon" aria-hidden="true"></i>
                <strong>${escapeHtml(node.label)}</strong>
                <span>${escapeHtml(node.detail)}</span>
            </div>`;
        }).join('');
        elements.topology.innerHTML = `<div class="topology-label">${escapeHtml(topology.label)}</div><div class="topology-flow">${nodes}</div>`;
    }

    function renderResult() {
        const total = incidents.length;
        const percent = Math.round((state.score / total) * 100);
        const missed = state.answers.filter(function (answer) { return !answer.correct; });
        const diagnosis = missed.length
            ? `Review ${missed.map(function (answer) { return answer.topic; }).join(', ')}.`
            : 'No weak area detected. You kept every failure contained.';
        let rank = 'Production Apprentice';
        if (state.score === total) rank = 'Incident Commander';
        else if (state.score >= 3) rank = 'Reliable Systems Engineer';
        else if (state.score >= 2) rank = 'On-call Investigator';

        elements.stage.hidden = true;
        elements.result.hidden = false;
        elements.stepLabel.textContent = 'Incident report complete';
        elements.score.textContent = `Best result: ${state.bestScore}/${total}`;
        updateProgress(100);
        elements.result.innerHTML = `<div class="result-summary">
                <div class="result-score-ring" style="--result-pct: ${percent}">
                    <span>${state.score}<small>/${total}</small></span>
                </div>
                <div class="result-copy">
                    <span class="result-overline">Shift complete</span>
                    <h2>${escapeHtml(rank)}</h2>
                    <p>You stabilized ${state.score} of ${total} systems on the first call. ${escapeHtml(diagnosis)}</p>
                    <div class="result-actions">
                        <button type="button" class="btn-primary" data-action="share"><i class="fas fa-share-nodes"></i> Share result</button>
                        <button type="button" class="btn-secondary" data-action="retry"><i class="fas fa-rotate-right"></i> Run again</button>
                        <a class="btn-secondary" href="${escapeHtml(root.dataset.articleUrl)}">Read the deep dive</a>
                    </div>
                    <span class="result-share-status" id="result-share-status" aria-live="polite"></span>
                </div>
            </div>
            <div class="result-breakdown">
                ${incidents.map(function (incident, index) {
                    const answer = state.answers[index];
                    const correct = answer && answer.correct;
                    return `<div class="result-breakdown-item ${correct ? 'is-correct' : 'is-wrong'}">
                        <i class="fas ${correct ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                        <div><strong>${escapeHtml(incident.topic)}</strong><span>${escapeHtml(incident.title)}</span></div>
                    </div>`;
                }).join('')}
            </div>`;
        elements.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function restart() {
        const best = state.bestScore;
        state = initialState(best);
        answered = false;
        saveState();
        track('lab_restarted', { lab: 'kafka_local_cache', best_score: best });
        renderIncident(true);
    }

    async function shareResult(button) {
        const text = `I stabilized ${state.score}/${incidents.length} incidents in the Kafka Local Cache Production Lab.`;
        const shareData = { title: 'Kafka Local Cache Incident Lab', text: text, url: window.location.href };
        const status = document.getElementById('result-share-status');
        try {
            if (navigator.share) {
                await navigator.share(shareData);
                if (status) status.textContent = 'Result shared.';
            } else {
                await navigator.clipboard.writeText(`${text} ${window.location.href}`);
                if (status) status.textContent = 'Result copied to your clipboard.';
            }
            track('lab_shared', { lab: 'kafka_local_cache', score: state.score });
        } catch (error) {
            if (error && error.name === 'AbortError') return;
            if (status) status.textContent = 'Copy this page URL to share your result.';
        }
        if (button) button.focus();
    }

    function updateProgress(percent) {
        const rounded = Math.round(percent);
        elements.progressBar.style.width = `${rounded}%`;
        elements.progress.setAttribute('aria-valuenow', String(rounded));
    }

    function track(eventName, properties) {
        if (window.umami && typeof window.umami.track === 'function') {
            window.umami.track(eventName, properties);
        }
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
}());
