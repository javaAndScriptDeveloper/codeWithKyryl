# Outbox article enhancement + site polish — design

Date: 2026-11-25 · Size: small change

## Intent

An engineering manager may review the site tomorrow. Show depth on the outbox article,
hide unfinished AI articles, and make code + diagrams look sharper.

## Goals

1. **Companion repo locally**: clone `github.com/javaAndScriptDeveloper/outboxes-article` into a
   gitignored folder (`examples/outboxes-article/`). Add `examples/` to `.gitignore` **and** to
   Jekyll `exclude` in `_config.yml` (else Jekyll publishes it).
2. **Hide articles** via existing mechanism (`published: false` + `sitemap: false`):
   - `dspy-gepa-vs-miprov2.md` — EN + 8 locales
   - `harness2-how-to.md`, `jev-how-to.md` — EN only
   - Check `_includes/hreflang.html` and any listings don't break.
3. **Outbox article (English only in this pass)** — additions:
   - Part 2: strengthen — no HTTP/Kafka/any external I/O inside an open transaction. Degraded
     Kafka/RPC ⇒ long-open transactions ⇒ held connections + row locks ⇒ pool exhaustion.
     Transaction duration must never depend on an external resource. Also: Kafka send inside tx
     is itself a dual write (sent, then rollback). Mention `@Transactional(timeout=…)` /
     `idle_in_transaction_session_timeout` as hard guard.
   - New part after the worker — **Fetch strategies**: cron, fixed delay, fixed rate, threshold
     (trigger when backlog ≥ N). Overlap: precise — single Spring instance `@Scheduled` does not
     overlap itself; overlap happens across pods, with `@Async`, Quartz concurrent jobs, k8s
     CronJob. `SKIP LOCKED` keeps it correct; cost is contention/wasted work. Drain-loop strategy:
     fetch batch → process → repeat until empty, then tick ends, next tick starts. Batch fetching
     (`LIMIT n` + `SKIP LOCKED`) instead of `findFirst`.
   - Submit side — **jitter**: avoid bursty, spiky load; set `next_attempt_at = now + random
     jitter` to flatten load. Also jitter on retry backoff (Part 4).
   - Part 2.5 — **zero-select outbox**: event carries full payload; listener executes directly
     and saves result/failure via callback; no re-select. Row inserted as `PROCESSING` with a lease
     so the poller doesn't double-run it. Drawback: service doesn't control its intake — can be
     flooded; classic polling outbox controls its own amount of work. Needs a dedicated bounded
     thread pool bean (`ThreadPoolTaskExecutor`), not the common pool. Max-throughput variant:
     buffer results in memory, flush as one batch update — crash loses the marks ⇒ tasks re-run
     (needs idempotency, Part 10).
   - Part 9 — **chunked delete**: deleting a huge set at once in Postgres ⇒ big WAL growth
     (plus replication lag, long locks). Delete in a loop of ~100k rows per transaction
     (author's practice) until nothing left. Autovacuum/bloat note for high-churn table.
   - Other gaps: graceful shutdown (in-flight tasks on deploy), payload versioning, Debezium/CDC
     as alternative to polling (in Ecosystem). Update Production Checklist accordingly.
   - Validate existing article claims while editing.
4. **Diagrams**: Mermaid `look: 'handDrawn'` + handwritten font (Google Fonts, e.g. Kalam);
   pin Mermaid script to an exact version (currently unpinned).
5. **Code highlighting**: keep Rouge; refresh `assets/css/syntax.css` palette, add language label
   on code blocks, ensure Java annotations/generics and SQL tokens are distinct.

## Non-goals

- Translating the outbox changes into 8 locales — **later, after author approves English**.
- Updating companion repo code — later, after approval; never commit/push it without asking.
- Do **not** mention time partitioning / `DROP PARTITION`, or `LISTEN/NOTIFY` (author decision).

## Anti-goals

- Breaking other articles' rendering (highlighting/mermaid change is site-wide).
- Deleting hidden articles.

## Approaches

- Diagrams: **A. Mermaid handDrawn (chosen)** — text-editable, cheap across 9 locales.
  B. Hand-drawn SVGs — closest look, but 9× static redraws.
- Highlighting: **A. Rouge + theme upgrade (chosen)** — zero JS, low risk.
  B. Shiki client-side — better grammars, ~1MB JS, flash, site-wide risk.

## Verification

`bundle exec jekyll build`; hidden articles absent from `_site` and sitemap; outbox page renders
with hand-drawn diagrams and labelled code blocks (browser check); existing `tests/` pass.

## Left to builder

Exact wording, code snippets, font choice, palette values.
