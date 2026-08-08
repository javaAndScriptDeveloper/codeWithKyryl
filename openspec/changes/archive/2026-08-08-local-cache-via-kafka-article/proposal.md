## Why

A Reddit thread ([r/apachekafka](https://www.reddit.com/r/apachekafka/comments/1vhv9nn/can_kafka_replace_redis_for_cache_synchronization/)) asked whether Kafka can replace Redis for broadcasting cache updates to ~25 Spring Boot pods. I have run exactly this pattern (compacted topic + per-pod consumer group + readiness gating) in production for years and want to share the answer as a full article with a runnable example, matching the depth of the site's existing tutorials (`_articles/outboxes.md`, `_articles/enums.md`).

## What Changes

- New article `_articles/local-cache-via-kafka.md` (Jekyll post) covering: the Reddit question, the broadcast-via-per-pod-consumer-group pattern, consistency tradeoffs vs Redis, readiness gating before serving traffic, tombstone-based deletes, orphaned consumer groups, startup-time/batch-consume concerns, and partitioning for concurrent consumption. Includes TL;DR block, mermaid diagrams, FAQ front matter, SEO front matter (`description`, `excerpt`, `tags`, `tech_icon`) per `CLAUDE.md` conventions.
- New runnable code example built on top of the existing scaffold at `/home/vampir/Documents/ssi/articles/kafka-backed-local-read-replica-article` (separate git repo, currently a generic untouched Spring Boot template):
  - A standalone library module implementing "not ready until fully consumed" (annotation-driven tracking of last-consume-time/errors, Spring readiness integration).
  - The main app module: consumes a compacted topic into a thread-safe local cache, exposes a scheduled job and an HTTP endpoint reading from that cache, consumer group name templated with a per-pod UUID sourced from a k8s ConfigMap.
  - Kafka in KRaft mode + a Kafka UI, a topic-init step that creates the compacted topic and pre-populates it (not from the app), k8s manifests or Helm chart for minikube, and Makefile automation so a reader can go from clone to running demo with a small number of commands.
- Article code snippets are copied from the finished, working example repo (not invented), so the example is built and verified before the article is written.

## Capabilities

### New Capabilities
- `local-cache-kafka-article`: the Jekyll blog post content, front matter, diagrams, and SEO/AEO conventions for the new article.
- `kafka-local-cache-example`: the companion runnable Spring Boot + Kafka (KRaft) example living in the external repo — library module, app module, containerization, and minikube deployment automation used as the source of truth for the article's code snippets.

### Modified Capabilities
(none — no existing spec-level behavior changes on this site)

## Impact

- **Affected repo (this repo)**: adds one new file under `_articles/`; no changes to layouts, includes, or existing posts. Follows existing `_articles/*.md` conventions (verify exact front matter fields against `outboxes.md` before writing).
- **Affected repo (external)**: `/home/vampir/Documents/ssi/articles/kafka-backed-local-read-replica-article` — adds a new Gradle module (library), extends the existing app module, adds Docker/k8s/Helm assets, extends the Makefile, updates the README. Has its own independent git history; changes there are committed separately from this repo's OpenSpec-tracked change.
- **No production systems affected** — the example targets local minikube only; no real Redis migration performed anywhere.
