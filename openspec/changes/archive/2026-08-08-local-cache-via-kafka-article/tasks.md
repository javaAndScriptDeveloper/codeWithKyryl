## 1. Repo restructure (example repo)

- [x] 1.1 Move existing `src/` to `app/src/`, move relevant Gradle config into `app/build.gradle.kts`, keep root `build.gradle.kts` for shared `subprojects {}` config (toolchain, Spotless, repositories)
- [x] 1.2 Add `readiness-gate/` module skeleton; update `settings.gradle.kts` with `include("readiness-gate", "app")`
- [x] 1.3 Update Dockerfile, `.dockerignore`, Makefile paths (`run`/`dev`/`test`/`build`/`up`/`image` targets) for the new module layout
- [x] 1.4 Run `./gradlew build` and existing tests; confirm green baseline before adding Kafka code

## 2. Readiness-gate library

- [x] 2.1 Add dependencies to `readiness-gate/build.gradle.kts` — **deviation**: no Kafka client dependency. The library ended up transport-agnostic (annotation + AOP + health indicator only), so it stays reusable outside Kafka contexts; `app` supplies the only Kafka-specific wiring.
- [x] 2.2 Implement `@ConfigConsumer` annotation and `ConsumptionTracker` (last-consumed-time + error state per tracked consumer)
- [x] 2.3 Implement the "fully consumed" check — **deviation**: not `AvailabilityChangeEvent`. `SpringApplication` publishes its own `AvailabilityChangeEvent(ACCEPTING_TRAFFIC)` right after `ApplicationReadyEvent`, which raced and overwrote a custom one. Used a `HealthIndicator` in the `readiness` health group instead (`ConfigConsumptionHealthIndicator`), which Kubernetes' probe polls directly — no race, no extra scheduler.
- [x] 2.4 Gated-scheduled-job pattern — implemented as a direct `tracker.isFullyConsumed()` check at the top of the job method (`CacheSnapshotJob`), documented pattern rather than a `@GatedScheduled` marker annotation.
- [x] 2.5 Unit tests (`ConsumptionTrackerTest`): readiness stays DOWN while messages/errors keep arriving, flips UP after the quiet period with no errors — covers both spec scenarios.

## 3. App: Kafka consumption + local cache

- [x] 3.1 Kafka config — **deviation**: `app.kafka.*` properties + a hand-written `KafkaConfig` (`ConsumerFactory`/`ConcurrentKafkaListenerContainerFactory` beans), not `spring.kafka.*`. Spring Boot 4.1 ships no Kafka autoconfiguration module yet, so there's no `spring.kafka.*` binding to lean on.
- [x] 3.2 Implement thread-safe `LocalConfigCache` (`ConcurrentHashMap`-backed)
- [x] 3.3 Implement `@KafkaListener` (annotated `@ConfigConsumer`) that upserts non-null records into the cache and removes entries on tombstone (null-value) records
- [x] 3.4 Implement dummy `@Scheduled` job reading from `LocalConfigCache`, gated on readiness
- [x] 3.5 Implement HTTP endpoint returning data sourced from `LocalConfigCache`
- [x] 3.6 Integration test (Testcontainers Kafka, KRaft mode) covering: cache populated after consumption, tombstone removes entry, endpoint reflects cache contents — `ConfigTopicCacheIntegrationTest`, full `:app:check` green.

## 4. Containerization

- [x] 4.1 Update multi-stage `Dockerfile` to build `:app:bootJar` (transitively building `:readiness-gate`) and produce the runtime image
- [x] 4.2 Extend `docker-compose.yml` with a local single-broker KRaft Kafka (`confluentinc/cp-kafka:7.6.0`, `.withKraft()`-equivalent env) + kafka-ui + a `kafka-topic-init` one-shot service, for fast local iteration outside minikube
- [x] 4.3 Verified `docker build` + full `docker compose --profile full up --build`: app connects to Kafka, consumes seed data, `/actuator/health/readiness` and `/api/cache` both confirmed working end to end

## 5. Kubernetes manifests (minikube)

- [x] 5.1 Kafka KRaft Deployment + Service manifest (single broker, `KAFKA_PROCESS_ROLES=broker,controller`, pinned `confluentinc/cp-kafka:7.6.0` — `apache/kafka:3.9.0` was tried first but its entrypoint failed to compute a routable `advertised.listeners` in this environment, both via Testcontainers and docker-compose)
- [x] 5.2 kafka-ui Deployment + Service manifest, pointed at the broker
- [x] 5.3 ConfigMap supplying `CONSUMER_GROUP_PREFIX`; pod-unique suffix via Downward API (`metadata.uid` → `POD_UID`) on the app Deployment; combined via Spring property placeholder resolution
- [x] 5.4 `kafka-topic-init` Job: waits for broker readiness, creates compacted topic (`cleanup.policy=compact`), seeds sample key/value records via Kafka CLI, seed data shared with docker-compose's seed file
- [x] 5.5 App Deployment (3 replicas) + Service — **deviation**: `NodePort`, not LoadBalancer. `minikube service app -n local-cache-demo --url` works directly with NodePort, no `minikube tunnel` process required — simpler for a reader following along.
- [x] 5.6 `kustomization.yaml` tying manifests together for `kubectl apply -k k8s/`, plus a `postgres.yaml` + `db-secret.yaml` not in the original plan (the app inherits a hard Postgres/Liquibase dependency from the base template — needed in the k8s demo too, or app pods crash-loop)

## 6. Build/deploy automation

- [x] 6.1 Makefile targets: `demo-build`, `demo-image` (docker build + `minikube image load`), `demo-deploy` (`kubectl apply -k` + wait for topic-init Job + app rollout), `demo-down`
- [x] 6.2 Top-level `demo-up` target chaining build → image → deploy, printing both the app and kafka-ui URLs
- [ ] 6.3 Manually validate end-to-end on a real minikube cluster — **not done in this session** (no minikube/kubectl available in this sandbox). Validated as much as possible without one: `kubectl kustomize`/kubeconform confirm all 13 rendered resources are schema-valid, and the equivalent flow (Kafka KRaft + kafka-ui + topic-init + app, readiness gate, cache endpoint, tombstone) was verified end-to-end via `docker compose --profile full`. Run `make demo-up` on a real minikube before publishing to confirm.

## 7. Example repo README

- [x] 7.1 Quick-start section (minikube prerequisites/resources, one-command deploy)
- [x] 7.2 ConfigMap → env var → Spring property consumer-group templating flow (Downward API vs. UUID-env-var tradeoff)
- [x] 7.3 Curl instructions for the cache-backed endpoint, including exposing the Service via minikube
- [x] 7.4 How to observe per-pod consumer groups and the compacted topic in kafka-ui
- [x] 7.5 Tombstone/delete behavior (verified the exact `kafka-console-producer --property null.marker=...` command against a live broker)
- [x] 7.6 Scaling replicas to observe broadcast behavior

## 8. Publish example repo

- [x] 8.1 Confirmed with user — a GitHub remote already existed (`javaAndScriptDeveloper/kafka-backed-local-read-replica-article`, matching the expected naming convention), so no new repo needed.
- [ ] 8.2 Push example repo to GitHub — **user explicitly declined** ("don't touch git here") when asked. All changes are committed-ready but left in the local working tree; user will commit/push themselves. The article's "Code" link points at the existing (not-yet-pushed) remote URL — push before publishing.

## 9. Article

- [x] 9.1 Front matter (`title`, `date`, `tags`, `excerpt`, `description`, `tech_icon`, `faq`) per `local-cache-kafka-article` spec
- [x] 9.2 Introduction: Reddit-discussion framing + link to the source thread
- [x] 9.3 TL;DR block
- [x] 9.4 Body sections covering all required topics, each grounded in explicit answers to the four Reddit questions (dedicated "Answering the four questions" section)
- [x] 9.5 Three Mermaid diagrams: topology/broadcast, readiness sequence, tombstone/delete flow
- [x] 9.6 Code snippets copied from the finished example repo, verified verbatim against source (imports/Javadoc trimmed, matching site convention)
- [x] 9.7 Pros/cons vs Redis section (table)
- [x] 9.8 Closing "Code" section linking to the GitHub repo (not yet pushed — see 8.2)
- [x] 9.9 Proofread against both specs' scenarios; verified snippet-to-source traceability
- [x] 9.10 `bundle exec jekyll build` check: post renders at `/2026/08/08/local-cache-via-kafka/`, FAQ JSON-LD + accordion present, all 3 mermaid blocks present, tutorials-page card renders, internal anchors resolve
