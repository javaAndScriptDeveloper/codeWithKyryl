## ADDED Requirements

### Requirement: Article file and front matter
The system SHALL provide a new post at `_articles/local-cache-via-kafka.md` with `layout: post`, a `date`, `tags` array, `excerpt`, `description`, and `tech_icon`, matching the structure of existing posts (`_articles/outboxes.md`, `_articles/enums.md`).

#### Scenario: Post front matter is complete
- **WHEN** the Jekyll site is built
- **THEN** `_articles/local-cache-via-kafka.md` front matter includes `layout: post`, `title`, `date`, `tags`, `excerpt`, `description`, and `tech_icon`, and the built page emits distinct SEO title/description (no duplicate/fallback to site defaults)

### Requirement: Reddit origin framing
The article SHALL open by stating the author enjoys following Reddit technical discussions, link the source thread, and frame the rest of the article as sharing production experience in answer to it.

#### Scenario: Reddit thread is linked and framed
- **WHEN** a reader opens the article
- **THEN** the introduction contains a working link to `https://www.reddit.com/r/apachekafka/comments/1vhv9nn/can_kafka_replace_redis_for_cache_synchronization/` and states the article shares the author's production experience in response to that thread

### Requirement: TL;DR block
The article SHALL include a `<div class="post-tldr" markdown="1">` block near the top summarizing the key takeaways, matching the pattern used in `_articles/outboxes.md`.

#### Scenario: TL;DR renders
- **WHEN** the article is rendered
- **THEN** a `post-tldr` block appears before the first major section and lists the core claims (compacted topic, per-pod consumer group broadcast, readiness gating, tombstone deletes)

### Requirement: Reddit questions answered explicitly
The article SHALL explicitly answer each of the four questions from the Reddit post: whether Kafka is a good Redis replacement here, whether all 25 pods receive each update, whether each pod needs its own consumer group, and pros/cons of the approach.

#### Scenario: All four questions are addressed
- **WHEN** a reader reads the article end to end
- **THEN** each of the four Reddit questions has a directly identifiable answer in the text (not only implied by code)

### Requirement: Technical content coverage
The article SHALL cover, with prose and at least one diagram where noted: the per-pod distinct consumer group broadcast pattern (vs. load-balanced consumer groups) [diagram], the eventual-consistency tradeoff vs Redis, readiness gating before serving traffic/scheduled jobs [diagram], orphaned consumer groups as an accepted cost, tombstone-based deletes and cache eviction/soft-delete choice [diagram], startup-time risk from full-topic replay and batch consuming as mitigation, and the need for multiple partitions plus a thread-safe local cache for concurrent consumption.

#### Scenario: Required topics present
- **WHEN** the article is reviewed against this list
- **THEN** every listed topic has a corresponding section, and the three noted diagrams (topology/broadcast, readiness sequence, tombstone/delete flow) are present as Mermaid diagrams

### Requirement: Code snippets sourced from working example
Code snippets embedded in the article SHALL be copied verbatim (or minimally trimmed for length) from the finished, verified companion example repository, not invented for the article.

#### Scenario: Snippet traceability
- **WHEN** a code block in the article is compared to the referenced file in the companion example repo
- **THEN** the snippet content matches the real file (allowing only whitespace/comment trimming for brevity)

### Requirement: FAQ front matter
The article SHALL include a `faq` front matter list of 3-5 question/answer pairs relevant to Kafka-as-cache-sync, following the pattern in `_articles/outboxes.md`.

#### Scenario: FAQ renders and emits structured data
- **WHEN** the article is built
- **THEN** the `faq` front matter list is present with 3-5 entries and the page renders the FAQ accordion via `_includes/faq.html`

### Requirement: Link to companion code repository
The article SHALL end with a "Code" section linking to the public repository hosting the companion example, following the pattern in `_articles/outboxes.md`.

#### Scenario: Code link present
- **WHEN** a reader reaches the end of the article
- **THEN** a "Code" section links to the companion example's public repository URL
