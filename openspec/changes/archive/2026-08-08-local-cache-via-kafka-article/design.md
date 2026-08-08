## Context

Two repos are touched:

1. **This repo** (`codeWithKyryl`, Jekyll) — gets one new article file. Low complexity, follows existing conventions in `_articles/outboxes.md` / `_articles/enums.md`.
2. **The example repo** (`/home/vampir/Documents/ssi/articles/kafka-backed-local-read-replica-article`, separate git history) — currently a *single-module* generic Spring Boot template (`rootProject.name = "spring-template"`, no subprojects, `src/` at root, Postgres+Liquibase+Testcontainers already wired, Docker/Makefile/CI already present). This needs to become a **multi-module** Gradle project (a readiness-gating library + the app) plus a full Kafka/minikube deployment story. This is the part that carries real design complexity and is the focus of this document.

The article's code snippets must be copied from this working example after it's built and verified — so the example is built first, article written second.

## Goals / Non-Goals

**Goals:**
- Convert the example repo to a multi-module Gradle build: a standalone `readiness-gate` library (annotation + readiness tracking + Spring Boot Actuator/Availability integration) and an `app` module that depends on it.
- App demonstrates: compacted-topic consumption into a thread-safe local cache, tombstone-based deletes, a scheduled job and an HTTP endpoint reading the cache, and a per-pod UUID-suffixed consumer group sourced from a k8s ConfigMap.
- Kafka runs in KRaft mode with a UI, deployed to minikube alongside the app (multiple replicas) via a small number of driving commands.
- Topic is compacted and pre-populated by a step outside the app (init container or k8s Job using the Kafka CLI).
- Reader experience: `minikube start` → one `make` target → running stack → curl-able endpoint → visible per-pod consumer groups in the Kafka UI.

**Non-Goals:**
- No production hardening (TLS, SASL/ACLs, HA Kafka, persistent volumes tuning) — this is a local teaching example.
- No actual Redis migration or Redis component in the example — the article discusses Redis only in prose/diagrams.
- No Helm templating engine features beyond what's needed for the ConfigMap/ ConfigMap-driven consumer group name and ordinary Deployment/Service manifests — plain k8s manifests are acceptable if simpler (see Decisions).

## Decisions

### 1. Gradle module layout
Move existing `src/` into `app/src/` (app module keeps `com.example.company` base package unless renamed — keep as-is to minimize churn) and add a new `readiness-gate/` module. Root `settings.gradle.kts` gains `include("readiness-gate", "app")`. Root `build.gradle.kts` keeps only shared config (Java toolchain, Spotless, common repositories) via `subprojects {}`; `app/build.gradle.kts` adds `implementation(project(":readiness-gate"))`.
*Alternative considered*: publish the library as a separate Maven-local artifact (`maven-publish` + `mavenLocal()`). Rejected — adds a manual `publishToMavenLocal` step between library and app builds, working against the "few commands" requirement. A Gradle project dependency (`project(":readiness-gate")`) builds both in one `./gradlew build` and is simpler for readers to follow.

### 2. Readiness-gate library design
- `@ConfigConsumer` annotation on `@KafkaListener` methods (or on the listener bean) to opt in to gating.
- A `ConsumptionTracker` bean records, per registered consumer, the timestamp of the last successfully processed record and any consume error; a scheduled check (fixed delay, e.g. every 1s) evaluates "no new messages in last N seconds (default configurable, e.g. 5s) AND no errors" per tracked consumer, and once **all** tracked consumers satisfy it, publishes an `AvailabilityChangeEvent(ReadinessState.ACCEPTING_TRAFFIC)`.
- Spring Boot's built-in `ReadinessState`/Actuator readiness group is reused (no custom `/actuator/health/readiness` reinvention) — the library only drives the existing `AvailabilityChangeEvent` mechanism, which Boot's readiness health indicator already listens to.
- Gated `@Scheduled` jobs use a small `@GatedScheduled` marker (or check `ApplicationAvailability.getReadinessState()` inside the job) so they no-op until ready; documented pattern rather than bytecode magic, to keep it readable in an article snippet.
- Kept as a separate module (not just a package in `app`) because the proposal explicitly calls for a standalone reusable library, and it makes the "library build → app build" story concrete and demonstrable in the article/README.

### 3. Local cache
Plain `ConcurrentHashMap<String, CacheEntry>` wrapped in a small `LocalConfigCache` service — sufficient to demonstrate thread-safety without pulling in Caffeine (Caffeine is for the *unrelated* `CacheConfig` already in the template and stays as-is / unused by this feature). Tombstone (null Kafka record value) → `map.remove(key)` (hard delete) is the default behavior shown in the code, with the soft-delete alternative discussed only in prose/README, not implemented, to keep the example focused.

### 4. Consumer group templating
Spring property `spring.kafka.consumer.group-id: ${CONSUMER_GROUP_ID}` in `application.yml`. `CONSUMER_GROUP_ID` env var is **not** generated by the app — it's set at the k8s manifest level, e.g. `local-cache-demo-${POD_UUID}` where `POD_UUID` is itself populated by an init container (or a wrapper entrypoint) that generates a UUID, since raw Kubernetes ConfigMaps can't generate random values on their own. Document this clearly: the "UUID from ConfigMap" pattern from the Reddit answer is approximated in k8s by combining a ConfigMap-supplied *prefix* with a pod-unique suffix (`metadata.uid` via the Downward API is a simpler, no-extra-container alternative and is preferred here — same broadcast effect, zero extra moving parts).
*Alternative considered*: sidecar/init container generating a random UUID into a shared file. Rejected as unnecessary complexity — the Downward API's pod UID already gives per-pod uniqueness without extra containers, and the article can note that a real UUID-in-env-var (as in the original Reddit answer) is equally valid if the team already has that env-injection tooling.

### 5. Kafka + UI
Kafka in KRaft mode via the official `apache/kafka` (or `bitnami/kafka` KRaft-mode) image — single broker, `KAFKA_PROCESS_ROLES=broker,controller`, no ZooKeeper. UI: **kafka-ui (provectuslabs/kafka-ui)** — actively maintained, single container, minimal config pointing at the broker's internal bootstrap address, no login setup required.

### 6. Deployment: plain k8s manifests, not Helm
Plain manifests under `k8s/` (Namespace, ConfigMap, Deployment+Service for Kafka, Deployment+Service for kafka-ui, Job for topic-init, Deployment+Service for the app, plus a `kustomization.yaml` for one-command `kubectl apply -k`). Chosen over Helm because a teaching example benefits from manifests a reader can open and read top-to-bottom without templating indirection; `kubectl apply -k k8s/` is a single command, satisfying the "one-command deploy" goal without a Helm dependency.
*Alternative considered*: Helm chart. Rejected for this example — Helm's value is templating variability across environments, which this single-environment minikube demo doesn't need; it would add a learning-curve tax for readers who just want to see the pattern.

### 7. Topic pre-population
A k8s `Job` (`topic-init`) runs after Kafka is ready (`kubectl wait` style readiness or an init container with a wait-for-broker loop), uses the Kafka CLI (`kafka-topics.sh --create --config cleanup.policy=compact`, then `kafka-console-producer.sh` fed a small seed file of key/value lines, or `kcat`) to create the compacted topic and seed sample records. The app's Deployment does not reference topic-creation logic at all — `auto.create.topics.enable` stays off/irrelevant since the Job owns topic lifecycle.

### 8. Image build & load into minikube
Multi-stage `Dockerfile` updated for the multi-module layout (build stage runs `./gradlew :app:bootJar`, which transitively builds `:readiness-gate`). Because minikube runs its own Docker daemon, the Makefile target builds the image and loads it via `minikube image load <tag>` (works for both the `docker` and other minikube drivers) rather than requiring `eval $(minikube docker-env)`, which is driver-dependent and easy to get wrong in a README.

### 9. Makefile automation
Extend the existing Makefile with: `demo-build` (gradle build of both modules), `demo-image` (docker build + `minikube image load`), `demo-deploy` (`kubectl apply -k k8s/` + wait for topic-init Job + wait for app rollout), and a top-level `demo-up` that chains all three plus prints the `minikube service` URL. `demo-down` tears down via `kubectl delete -k k8s/`. This keeps the existing `run`/`dev`/`test`/`up`/`down` targets (Postgres-based, template-inherited) untouched since they're orthogonal to this demo.

## Risks / Trade-offs

- **[Risk]** Single-broker KRaft Kafka in minikube may be resource-heavy on constrained dev machines. → **Mitigation**: document minimum minikube resources (e.g. `minikube start --cpus=4 --memory=8192`) in the README; keep replica counts low (2-3 app pods) by default.
- **[Risk]** Pod-UID-based "distinct group per pod" (Decision 4) diverges from the literal "UUID via ConfigMap" wording in the original Reddit answer / proposal. → **Mitigation**: article explicitly explains both approaches and why Downward API pod UID is the simpler k8s-native equivalent; README calls this out too, so it doesn't read as silently deviating from the brief.
- **[Risk]** Restructuring the existing single-module repo into multi-module could break the template's existing Postgres/Testcontainers/CI setup. → **Mitigation**: move `src` → `app/src` mechanically, keep `app/build.gradle.kts` a near-copy of the original `build.gradle.kts` (minus what moves to root `subprojects{}`), run `./gradlew build` and existing tests after the move before adding any Kafka code, to establish a green baseline first.
- **[Risk]** `kafka-ui` image tags / Kafka KRaft image tags drift; a pinned tag from today could be pulled later and break. → **Mitigation**: pin exact image versions in manifests, note the pin in the README so readers know to bump deliberately.
- **[Risk]** The article links to a public GitHub repo (per the `outboxes.md` convention: `github.com/javaAndScriptDeveloper/...`), but the example currently only exists locally with one local commit. → **Mitigation**: tasks.md includes an explicit step to push the finished example repo to GitHub (new repo under the author's existing `javaAndScriptDeveloper` account, naming consistent with the local dir) before the article references its URL; this is a manual/user-confirmed action, not automated by this change.

## Migration Plan

1. Convert example repo to multi-module (`readiness-gate`, `app`), verify existing build/tests still pass.
2. Implement `readiness-gate` library + tests.
3. Implement Kafka consumption, local cache, tombstone handling, scheduled job, endpoint in `app`, wired to the library.
4. Update Dockerfile for multi-module build; verify local `docker build` + `docker run` works standalone (without k8s) against a local Kafka via `docker-compose` for fast iteration.
5. Author k8s manifests (Kafka KRaft, kafka-ui, topic-init Job, ConfigMap, app Deployment/Service) + `kustomization.yaml`.
6. Extend Makefile with `demo-*` targets; validate full `minikube start` → `make demo-up` → curl → scale → observe in kafka-ui flow manually.
7. Write example repo README sections per spec.
8. Push example repo to GitHub (user-confirmed repo name/visibility).
9. Write the article in this repo, copying verified snippets from the now-finished example, add diagrams, FAQ, front matter.
10. Proofread article against `kafka-local-cache-example` and `local-cache-kafka-article` specs' scenarios.

No rollback concerns beyond normal git revert — no production systems touched.

## Open Questions

- Exact GitHub repo name/visibility for the pushed example (default assumption: public, named after the local directory, under the same account as `outboxes-article`) — confirm before publishing the article's "Code" link.
- Default value of N (quiet-period seconds) for "fully consumed" — proposing 5s default, configurable via property; confirm acceptable for the demo's seed-data volume.
- Whether the article's tombstone section should also sketch the soft-delete/mark-inactive alternative in code, or prose-only (Decision 3 currently scopes it to prose-only for the example, both discussed in the article).
