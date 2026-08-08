## Purpose

Defines the required behavior of the companion runnable example (external repo:
`kafka-backed-local-read-replica-article`) that backs the local-cache-via-kafka article — the
readiness-gating library, the Kafka-consuming app, and the minikube/docker-compose deployment.

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

### Requirement: Per-pod consumer group via ConfigMap prefix + Downward API suffix
Each app pod SHALL run with a distinct Kafka consumer group name, assembled from a Kubernetes ConfigMap-supplied prefix and a per-pod-unique Downward API value (`metadata.uid`), joined via Spring Boot property placeholder resolution.

#### Scenario: Distinct consumer groups across pods
- **WHEN** the app Deployment is scaled to more than one replica
- **THEN** each pod's consumer group, as visible in the Kafka UI, is unique per pod

### Requirement: KRaft-mode Kafka with UI
The deployment SHALL run Kafka in KRaft mode (no ZooKeeper) alongside a Kafka UI reachable from the reader's browser via minikube for inspecting topics and consumer groups.

#### Scenario: Kafka UI shows topic and consumer groups
- **WHEN** the demo stack is running and the Kafka UI is opened
- **THEN** the compacted topic and the per-pod consumer groups are visible in the UI

### Requirement: Compacted topic pre-populated outside the app
The compacted topic SHALL be created with `cleanup.policy=compact` and pre-populated with sample data by a step that runs independently of the application (init container, Kubernetes Job, or Makefile bootstrap step using the Kafka CLI), not by application code.

#### Scenario: Topic exists and has data before app starts consuming
- **WHEN** the topic-init step completes
- **THEN** the topic exists with `cleanup.policy=compact` and contains sample records, and no application code path is responsible for creating or seeding it

### Requirement: One-command minikube deployment
The example repo SHALL provide Makefile targets (or a documented equivalent) that build the library, build the app (depending on the library), build the Docker image, and deploy the full stack (Kafka, UI, topic-init, app with multiple replicas) to a running minikube cluster, in dependency order, with a small number of commands.

#### Scenario: Clean clone reaches a running demo
- **WHEN** a reader with a running minikube clones the repo and runs the documented command(s)
- **THEN** the library, app, and Docker image build successfully and the full stack becomes available in the cluster without manual file editing

### Requirement: README quick start and observability instructions
The README SHALL document: minikube prerequisites and startup, the one-command deploy path, how the ConfigMap-to-env-var-to-Spring-property consumer group templating works, how to reach and curl the cache-backed endpoint (including exposing the Service via minikube), how to observe per-pod consumer groups and the compacted topic in the Kafka UI, how tombstone deletes behave, and how to scale replicas to observe broadcast behavior.

#### Scenario: README covers all required topics
- **WHEN** the README is reviewed against this list
- **THEN** every listed topic (quick start, config templating flow, curl instructions, Kafka UI observation, delete/tombstone behavior, scaling replicas) has a corresponding section
