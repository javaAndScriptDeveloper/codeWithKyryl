# Outbox Article Enhancement + Site Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide three unfinished articles, deepen the English outbox article, and make code blocks and diagrams look sharper before an engineering-manager review.

**Architecture:** Jekyll site (minima, Rouge, Mermaid from CDN). Config/front-matter/CSS/layout edits plus Markdown prose. Verification = `bundle exec jekyll build` + a node test over `_site` + browser check.

**Tech Stack:** Jekyll, Liquid, Rouge, Mermaid 11, Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-25-outbox-article-enhance-design.md`

## Global Constraints

- English outbox article only (`_articles/outboxes.md`). Do NOT touch `_articles/*/outboxes.md` locales.
- Do NOT mention time partitioning / `DROP PARTITION`, nor `LISTEN/NOTIFY`.
- Do NOT commit/push the companion repo. Do NOT delete hidden articles.
- Hide = `published: false` + `sitemap: false` in front matter.
- Chunked delete figure: ~100k rows per transaction (author's practice).
- Mermaid script pinned: `https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js`.
- Commit messages: imperative, ≤72-char subject, body = why, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Hidden DSPy article still referenced by hreflang of other locales → `_site` must contain no `dspy-gepa`, `harness2`, `jev-how-to` URLs anywhere (sitemap, feed, index, hreflang). Test in Task 2.
2. Mermaid `handDrawn` look is officially for flowchart/state diagrams; sequence diagrams may ignore it → browser check in Task 3 must look at a sequence diagram too; handwritten font must still apply there.
3. Site-wide CSS change breaks other articles' code blocks (enums, local-cache) → browser check in Task 4 covers one non-outbox article.
4. `examples/` cloned repo leaks into `_site` → test in Task 1.
5. Zero-select section reintroduces the double-execution race → Task 6 prose must state row is inserted as `PROCESSING` with lease.

---

### Task 1: Companion repo folder, ignored by git and Jekyll

**Files:**
- Modify: `.gitignore`, `_config.yml:118-130`
- Create: `tests/site-build.test.js`

- [ ] **Step 1: Write failing test** `tests/site-build.test.js` (reads built `_site`):
  `test('companion examples are not published')` → `assert.equal(fs.existsSync('_site/examples'), false)`.
- [ ] **Step 2:** `git clone https://github.com/javaAndScriptDeveloper/outboxes-article examples/outboxes-article`; `bundle exec jekyll build`; `node --test tests/site-build.test.js` → FAIL.
- [ ] **Step 3:** add `examples/` to `.gitignore` and to `exclude:` in `_config.yml`.
- [ ] **Step 4:** rebuild, rerun → PASS; `git status` shows no `examples/`.
- [ ] **Step 5:** commit.

### Task 2: Hide DSPy, Harness², Jev

**Files:**
- Modify front matter: `_articles/dspy-gepa-vs-miprov2.md`, `_articles/{de,es,fr,ja,pt-BR,ru,uk,zh-CN}/dspy-gepa-vs-miprov2.md`, `_articles/harness2-how-to.md`, `_articles/jev-how-to.md`
- Test: `tests/site-build.test.js`

- [ ] **Step 1: Failing test** `test('hidden articles have no page and no link in the site')`: walk every file in `_site`; assert none has path or content matching `/dspy-gepa-vs-miprov2|harness2-how-to|jev-how-to/`.
- [ ] **Step 2:** build + run → FAIL.
- [ ] **Step 3:** add `published: false` and `sitemap: false` to all 11 files.
- [ ] **Step 4:** build + run → PASS. If links still appear (e.g. a hard-coded link in another article), report and fix the linking page.
- [ ] **Step 5:** commit.

### Task 3: Hand-drawn Mermaid diagrams

**Files:** Modify `_layouts/post.html:22-58`, `assets/css/post.css`

- [ ] **Step 1:** pin script URL (Global Constraints); add `look: 'handDrawn'`, `fontFamily: '"Kalam", cursive'` to `mermaid.initialize`; load Kalam (400,700) from Google Fonts in `post.html`.
- [ ] **Step 2:** `node --test tests/` still passes; build OK.
- [ ] **Step 3: Browser check** `/2026/06/07/outboxes/`: state diagram (Part 3) and flowchart (Part 6) look sketchy; sequence diagrams render with Kalam font, no errors in console.
- [ ] **Step 4:** commit.

### Task 4: Rouge theme refresh + language label

**Files:** Modify `assets/css/syntax.css`, `assets/css/post.css`, `_includes/copy-code.html`

- [ ] **Step 1:** palette: keep dark background; distinct colours for keywords, annotations (`.nd`), types/classes (`.nc`, `.kt`), strings, comments (italic, muted), SQL keywords; slightly larger line-height and rounded block.
- [ ] **Step 2:** in `copy-code.html`, read language from the `language-xxx` class on the Rouge wrapper div and render a small uppercase label (top-left) on each `pre`; skip `plaintext`/none.
- [ ] **Step 3: Browser check** outbox article and `enums` article: Java/SQL/Kotlin blocks labelled, readable, copy button still works.
- [ ] **Step 4:** commit.

### Task 5: Outbox — transactions, fetch strategies, jitter

**Files:** Modify `_articles/outboxes.md` (Part 1 worker, Part 2 tail, new "Part 1.5 — Fetch Strategies" after The Worker, Part 4 backoff)

- [ ] **Step 1:** Part 2 tail: callout — no HTTP/Kafka/external I/O inside an open transaction; degraded Kafka/RPC ⇒ long-open transactions ⇒ held connections + locks ⇒ pool exhaustion; transaction duration must never depend on an external resource; Kafka send inside tx is itself a dual write; guards `@Transactional(timeout = …)` and `idle_in_transaction_session_timeout`.
- [ ] **Step 2:** Fetch Strategies section: cron / fixedDelay / fixedRate / threshold; overlap precise (single instance `@Scheduled` doesn't overlap itself; pods, `@Async`, Quartz, k8s CronJob do); `SKIP LOCKED` keeps it correct, cost = contention; drain loop (fetch batch → process → repeat until empty, then tick ends); batch fetch `LIMIT n FOR UPDATE SKIP LOCKED` snippet; small hand-drawn flowchart of drain loop.
- [ ] **Step 3:** submit-side jitter: avoid big fast load spikes; `next_attempt_at = now + random(0..N)`; Part 4: full-jitter backoff one-liner.
- [ ] **Step 4:** build OK; commit.

### Task 6: Outbox — zero-select outbox (Part 2.5)

**Files:** Modify `_articles/outboxes.md` Part 2.5

- [ ] **Step 1:** new subsection "Zero-Select Outbox": event carries full payload; row inserted as `PROCESSING` with lease; listener executes on dedicated `ThreadPoolTaskExecutor` bean (bounded queue, named threads) via `@Async("outboxExecutor")`; result/failure saved via callback; no re-select. Snippets: event record with payload, executor bean, listener.
- [ ] **Step 2:** drawback: no control over intake → flood; polling outbox controls own amount of work; bounded pool + rejection → leave row for poller (lease expiry).
- [ ] **Step 3:** max-throughput variant: buffer results in memory, flush one batch update; crash loses marks ⇒ tasks re-run ⇒ needs idempotency (link Part 10).
- [ ] **Step 4:** build OK; commit.

### Task 7: Outbox — chunked cleanup, gaps, checklist, validation

**Files:** Modify `_articles/outboxes.md` Part 9, Part 5/new short sections, Ecosystem, Production Checklist, TL;DR

- [ ] **Step 1:** Part 9: huge single DELETE ⇒ big WAL growth, replication lag, long locks; loop deleting ~100k rows per transaction until 0 (`DELETE … WHERE id IN (SELECT id … LIMIT :batch)` snippet); autovacuum/bloat note for high-churn table.
- [ ] **Step 2:** short notes: graceful shutdown (stop fetching, finish/release in-flight on deploy), payload versioning (`payload_version` / tolerant reader); Ecosystem: Debezium/CDC as polling alternative.
- [ ] **Step 3:** update Production Checklist + TL;DR with new items.
- [ ] **Step 4:** read whole article for factual errors; fix and list them in final report.
- [ ] **Step 5:** build, all node tests, browser pass over whole article; commit.
