---
layout: lab
permalink: /labs/kafka-local-cache/
title: "Kafka Local Cache Incident Lab"
description: "Diagnose four production failures in a Kafka-backed local cache: consumer groups, startup replay, readiness gates, and tombstones."
---

<section class="lab-hero">
    <div class="container lab-hero-inner">
        <a class="lab-back" href="{{ '/practice/' | relative_url }}">
            <i class="fas fa-arrow-left"></i> Back to practice
        </a>
        <div class="lab-hero-copy">
            <span class="lab-eyebrow"><i class="fas fa-screwdriver-wrench"></i> Production Incident Lab</span>
            <h1>Kafka Local Cache: Four Failures Before Lunch</h1>
            <p>You are on call for a Spring Boot service that materializes configuration from Kafka into every pod. Keep the service correct through four escalating incidents.</p>
            <div class="lab-hero-meta" aria-label="Lab details">
                <span><i class="fas fa-clock"></i> 5 minutes</span>
                <span><i class="fas fa-layer-group"></i> 4 incidents</span>
                <span><i class="fas fa-signal"></i> Middle</span>
            </div>
        </div>
    </div>
</section>

<div class="lab-page">
    <div class="container">
        <div class="lab-shell" id="incident-lab" data-article-url="{{ '/2026/08/08/local-cache-via-kafka/' | relative_url }}">
            <div class="lab-toolbar">
                <div>
                    <span class="lab-step-label" id="lab-step-label">Incident 1 of 4</span>
                </div>
                <div class="lab-score" id="lab-score">Systems stabilized: 0</div>
            </div>
            <div class="lab-progress" role="progressbar" aria-label="Incident progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="lab-progress-bar" id="lab-progress-bar"></div>
            </div>

            <div id="lab-stage">
                <div class="lab-grid">
                    <section class="incident-panel" aria-labelledby="incident-title">
                        <div class="incident-heading">
                            <span class="incident-number" id="incident-number">INC-001</span>
                            <span class="incident-severity" id="incident-severity">SEV-2</span>
                        </div>
                        <h2 id="incident-title"></h2>
                        <p class="incident-brief" id="incident-brief"></p>

                        <div class="incident-evidence">
                            <h3><i class="fas fa-terminal"></i> Evidence</h3>
                            <ul id="incident-evidence"></ul>
                        </div>

                        <div class="incident-config">
                            <div class="incident-config-title">Relevant configuration</div>
                            <pre><code id="incident-config"></code></pre>
                        </div>

                        <div class="topology" id="incident-topology" aria-label="System topology"></div>
                    </section>

                    <section class="response-panel" aria-labelledby="response-question">
                        <div class="response-kicker">Your call</div>
                        <h2 id="response-question"></h2>
                        <p class="response-hint">Choose the safest production response. Number keys work too.</p>
                        <div class="response-options" id="response-options" role="group" aria-labelledby="response-question"></div>
                        <div class="response-feedback" id="response-feedback" hidden aria-live="polite"></div>
                        <div class="response-actions" id="response-actions"></div>
                    </section>
                </div>
            </div>

            <section class="lab-result" id="lab-result" hidden aria-live="polite"></section>
        </div>

        <noscript>
            <div class="lab-noscript">This incident lab needs JavaScript to run. The accompanying article remains fully available without it.</div>
        </noscript>

        <section class="lab-context">
            <div>
                <span class="lab-context-label">Want the engineering behind the answers?</span>
                <h2>Read the complete production pattern</h2>
                <p>The deep dive covers compacted topics, per-pod consumer groups, fixed startup targets, readiness gating, tombstones, and the operational limits of this design.</p>
            </div>
            <a class="btn-secondary" href="{{ '/2026/08/08/local-cache-via-kafka/' | relative_url }}">Read the article <i class="fas fa-arrow-right"></i></a>
        </section>
    </div>
</div>
