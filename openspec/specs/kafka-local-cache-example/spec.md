## Purpose

Defines the required behavior of the companion runnable example (external repo:
`kafka-backed-local-read-replica-article`) that backs the local-cache-via-kafka article — the
readiness-gating library, the Kafka-consuming app, and its docker-compose deployment.

## Requirements

### Requirement: Readiness-gating library module
The example repo SHALL contain a standalone library module providing an annotation to mark Kafka listener methods as config consumers, tracking per-listener last-consumed-time and error state, and exposing a "fully consumed" state (no new messages for a configurable N seconds AND no consume errors) integrated with Spring Boot's readiness state.

#### Scenario: Readiness stays DOWN until fully consumed
- **WHEN** the app starts and the compacted topic still has unconsumed records
- **THEN** the readiness health indicator reports DOWN and scheduled jobs annotated as gated do not run

#### Scenario: Readiness flips UP after quiet period
- **WHEN** no new messages have been consumed for the configured N seconds and no consume errors have occurred
- **THEN** the readiness health indicator reports UP and gated scheduled jobs are permitted to run

### Requirement: Local cache consumption from compacted topic
The main app module SHALL consume the compacted topic into an in-memory, thread-safe local cache using the readiness-gating library, and SHALL treat a record with a null value as a tombstone that removes (or marks inactive) the corresponding cache entry.

#### Scenario: Cache populated from topic
- **WHEN** the app finishes initial consumption of the topic
- **THEN** the local cache contains an entry for every non-tombstoned key present in the topic

#### Scenario: Tombstone removes entry
- **WHEN** a record with a null value (tombstone) for an existing key is consumed
- **THEN** the corresponding entry is removed from (or marked inactive in) the local cache

### Requirement: Cache-backed scheduled job and endpoint
The app module SHALL expose one `@Scheduled` job and one HTTP endpoint, both reading from the local cache, demonstrating consumption of cached data after readiness.

#### Scenario: Endpoint reflects cache contents
- **WHEN** a client calls the exposed HTTP endpoint after the app reports ready
- **THEN** the response reflects the current contents of the local cache

### Requirement: Per-container consumer group via env prefix + Docker hostname suffix
Each app container SHALL run with a distinct Kafka consumer group name, assembled from a human-picked prefix (`CONSUMER_GROUP_PREFIX`, set in `docker-compose.yml`) and Docker's own per-container `HOSTNAME` value, joined via Spring Boot property placeholder resolution — no explicit per-instance env var, sidecar, or generated UUID required.

#### Scenario: Distinct consumer groups across containers
- **WHEN** the `app` service is scaled to more than one replica
- **THEN** each container's consumer group, as visible in kafka-ui, is unique per container

### Requirement: KRaft-mode Kafka with UI
The docker-compose stack SHALL run Kafka in KRaft mode (no ZooKeeper) alongside a kafka-ui service reachable from the reader's browser on a published port, for inspecting topics and consumer groups.

#### Scenario: Kafka UI shows topic and consumer groups
- **WHEN** the demo stack is running and the Kafka UI is opened
- **THEN** the compacted topic and the per-container consumer groups are visible in the UI

### Requirement: Compacted topic pre-populated outside the app
The compacted topic SHALL be created with `cleanup.policy=compact` and pre-populated with sample data by a one-shot `kafka-topic-init` compose service using the Kafka CLI, which the `app` service depends on via `condition: service_completed_successfully` — not by application code.

#### Scenario: Topic exists and has data before app starts consuming
- **WHEN** `kafka-topic-init` completes
- **THEN** the topic exists with `cleanup.policy=compact` and contains sample records, and no application code path is responsible for creating or seeding it, and the `app` service does not start until this completes

### Requirement: One-command docker-compose deployment
The example repo SHALL provide a Makefile target (or documented equivalent) that builds the app image (transitively building the readiness-gate library) and brings up the full stack — Kafka, kafka-ui, topic-init, app — with a single `docker compose` invocation, with the app's HTTP port published to the host. The app module SHALL carry no dependency (database, HTTP client, API-doc generator, etc.) not required to demonstrate the Kafka-backed local cache pattern.

#### Scenario: Clean clone reaches a running demo
- **WHEN** a reader with Docker installed clones the repo and runs the documented command
- **THEN** the app, Kafka, and kafka-ui become reachable on the host and `curl localhost:8080/api/cache` returns the seeded cache contents once the readiness gate opens

### Requirement: README quick start and observability instructions
The README SHALL document: the one-command `docker compose` deploy path, how the env-prefix-plus-Docker-hostname consumer group is assembled, how to curl the cache-backed endpoint directly on the host, how to observe consumer groups and the compacted topic in kafka-ui, how tombstone deletes behave, and how to scale the `app` service to observe additional distinct consumer groups.

#### Scenario: README covers all required topics
- **WHEN** the README is reviewed against this list
- **THEN** every listed topic (quick start, config templating flow, curl instructions, Kafka UI observation, delete/tombstone behavior, scaling) has a corresponding section
