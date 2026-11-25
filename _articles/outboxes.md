---
layout: post
lang_key: outboxes
title: "The Transactional Outbox Pattern: From a Single Task to a Production-Grade Async Engine"
date: 2026-06-07
tags: [pattern, postgres, spring-boot, java]
excerpt: "How to build a reliable async task execution engine on top of PostgreSQL and Spring Boot — from a basic single-type outbox to a multi-type dispatcher with retries, heartbeats, ordering guarantees, and production monitoring."
description: "A practical guide to the Transactional Outbox Pattern in Java, Spring Boot and PostgreSQL — solving the dual-write problem with reliable async task execution."
faq:
  - question: "What is the Transactional Outbox Pattern?"
    answer: "The Transactional Outbox Pattern solves the dual-write problem by writing a task row into the **same database transaction** as your domain change instead of calling an external system directly. A background worker then reads the outbox table and executes the task. Because the domain write and the task write commit atomically, the task can never be lost even if the external call or the app crashes."
  - question: "What problem does the outbox pattern solve?"
    answer: "It solves the **dual-write problem**: when an operation must both update the database and call an external system (publish an event, send an email, call an API), there is no shared transaction across the two. If one succeeds and the other fails you get inconsistent state. The outbox makes the second action part of the database transaction, so they succeed or fail together."
  - question: "Do I need Kafka or a message broker to use the outbox pattern?"
    answer: "No. The outbox pattern works with just a relational database. A scheduled worker can poll the outbox table directly using `SELECT ... FOR UPDATE SKIP LOCKED`. A broker like Kafka is optional — you can publish from the outbox, but PostgreSQL alone is enough for reliable async execution."
  - question: "How do multiple workers avoid processing the same outbox row?"
    answer: "Use `SELECT ... FOR UPDATE SKIP LOCKED` when claiming rows. Each worker locks the rows it picks and `SKIP LOCKED` makes other workers skip already-locked rows instead of blocking, so multiple instances can poll the same table concurrently without double-processing."
  - question: "How do you handle failed tasks and retries in an outbox?"
    answer: "Give each task a state machine (PENDING → PROCESSING → COMPLETED/FAILED), a retry counter, and a `next_attempt_at` timestamp for exponential backoff. A heartbeat / lease timestamp lets you reclaim tasks orphaned by a crashed worker, and a max-retry threshold moves poison messages to a dead-letter state for manual inspection."
---

# The Transactional Outbox Pattern: From a Single Task to a Production-Grade Async Engine

There is a class of bugs that never shows up in your unit tests and rarely appears in staging.
It appears in production, at 2am, when your app saves a record to the database, then tries to
call an external service — and one of them fails. One side committed. The other didn't. Nobody
knows until a user complains.

This is the **dual-write problem**, and the Transactional Outbox Pattern is the standard answer
to it. The idea is simple: instead of calling the external system directly, write a task into the
same database transaction as your domain change. A background worker picks it up and executes it.
The write is atomic. The task cannot be lost.

What's less documented is everything that comes after the basic idea — what happens when tasks
fail, when two workers race for the same row, when your app crashes mid-execution, when you have
ten different task types living in one table, and when your stakeholders ask why the queue depth
spiked at 3am last Tuesday.

That's what this article covers.

I'll work through a single concrete scenario — a **report generation service** — and evolve it
step by step from the simplest possible outbox to something I'd be comfortable running in
production. Every code snippet is from a real working repo linked at the end.

Stack: **Java, Spring Boot, PostgreSQL**.

<div class="post-tldr" markdown="1">
<p class="post-tldr-title">TL;DR</p>

- The **Transactional Outbox Pattern** fixes the dual-write problem by writing a task row in the **same DB transaction** as your domain change, then executing it from a background worker.
- Poll the outbox table with `SELECT ... FOR UPDATE SKIP LOCKED` so multiple workers can run concurrently without double-processing.
- Production-grade requires more than the basic idea: a **state machine**, **retries with backoff**, **heartbeats/leases** to recover crashed workers, **ordering** guarantees, and **monitoring** of queue depth.
- You don't need Kafka — **PostgreSQL alone** is enough for reliable async execution.
</div>

---

## The Scenario

```mermaid
sequenceDiagram
    actor User as User (Backoffice)
    participant API as ReportGenerationService
    participant DB as PostgreSQL

    User->>API: POST /reports (from, to)
    API->>DB: INSERT report_generation_tasks (PENDING)
    DB-->>API: task saved
    API-->>User: 202 Accepted

    loop Scheduler every 1s
        API->>DB: SELECT ... WHERE state = PENDING FOR UPDATE SKIP LOCKED
        DB-->>API: task row
        API->>API: generateReport()
        API->>DB: UPDATE state = COMPLETED
    end
```

We're building a CRM. Users can request monthly analytics reports from a backoffice UI.
Generating a report means aggregating tens of millions of rows — it can take minutes.
Obviously we can't do this synchronously in an HTTP request.

The user clicks a button. The backend accepts the request, saves it, and responds immediately.
A background worker picks up the task, runs the generation, and updates the status when done.

This is the simplest case where an outbox makes sense: work that is genuinely async by nature,
where the user already expects to wait.

---

## Part 1 — The Basic Outbox

### What Every Outbox Needs

At its core, any outbox table needs three things:

- **State** — where is this task in its lifecycle?
- **Payload** — what exactly needs to be executed?
- **Timestamps** — when was it created, when did it last change?

```sql
CREATE TYPE task_state AS ENUM ('PENDING', 'COMPLETED');

CREATE TABLE report_generation_tasks (
                                       id         UUID       PRIMARY KEY DEFAULT gen_random_uuid(),
                                       state      task_state NOT NULL    DEFAULT 'PENDING',
                                       payload    JSONB      NOT NULL,
                                       created_at TIMESTAMP  NOT NULL    DEFAULT now(),
                                       updated_at TIMESTAMP  NOT NULL    DEFAULT now()
);
```

The payload for our use case is a date range:

```java
@Value
@Builder
@Jacksonized
public class ReportGenerationPayload {
  Instant from;
  Instant to;
}
```

The JPA entity:

```java
@Entity
@Table(name = "report_generation_tasks")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReportGenerationEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(updatable = false, nullable = false)
    private UUID id;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, columnDefinition = "task_state")
    private TaskState state;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, updatable = false, columnDefinition = "jsonb")
    private ReportGenerationPayload payload;

    @CreationTimestamp
    @Column(nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(nullable = false)
    private Instant updatedAt;
}
```

Submitting a task:

```java
@Service
@RequiredArgsConstructor
public class ReportGenerationService {

    private final ReportGenerationRepository repository;

    public void submit(ReportGenerationCommand command) {
        repository.save(ReportGenerationEntity.builder()
                .state(TaskState.PENDING)
                .payload(ReportGenerationPayload.builder()
                        .from(command.getFrom())
                        .to(command.getTo())
                        .build())
                .build());
    }
}
```

### The Worker

A scheduled job polls for pending tasks and executes them:

```java
@Component
@RequiredArgsConstructor
public class ReportGenerationScheduledJob {

    private final ReportGenerationTaskService taskService;

    @Scheduled(fixedDelay = 1000)
    public void run() {
        taskService.fetchAndProcess();
    }
}
```

```java
@Service
@RequiredArgsConstructor
public class ReportGenerationTaskService {

    private final ReportGenerationRepository repository;

    public void fetchAndProcess() {
        repository.findFirstByStateOrderByCreatedAt(TaskState.PENDING)
                .ifPresent(task -> {
                    generateReport(task);
                    task.setState(TaskState.COMPLETED);
                    repository.save(task);
                });
    }

    private void generateReport(ReportGenerationEntity task) {
        // actual report generation logic
    }
}
```

```java
public interface ReportGenerationRepository extends JpaRepository<ReportGenerationEntity, UUID> {
    Optional<ReportGenerationEntity> findFirstByStateOrderByCreatedAt(TaskState state);
}
```

This works in a single-instance app with no failures. In the real world, it has two problems:
two workers can claim the same task simultaneously, and tasks can fail without any recovery path.
Let's fix both.

---

## Part 2 — Concurrency: Two Workers, One Task

When two scheduler threads — or two app instances — run the fetch query at the same moment,
both can read the same `PENDING` row and both will try to execute it. The result is duplicate work
at best, corrupted state at worst.

The fix is a database lock taken at fetch time. PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED`
is purpose-built for exactly this use case: it locks the row for the current transaction and skips
any rows that are already locked by another transaction, rather than waiting.

```java
public interface ReportGenerationRepository extends JpaRepository<ReportGenerationEntity, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHint(name = AvailableSettings.JAKARTA_LOCK_TIMEOUT, value = "-2") // -2 = SKIP_LOCKED
    Optional<ReportGenerationEntity> findFirstByStateOrderByCreatedAt(TaskState state);
}
```

The `SKIP_LOCKED` hint value `-2` is what Hibernate translates to the `SKIP LOCKED` clause.
Since there's no first-class annotation for this, it's worth extracting into a reusable annotation
so you don't scatter the magic number across your repositories:

```java
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.ANNOTATION_TYPE})
@QueryHints(@QueryHint(
    name = AvailableSettings.JAKARTA_LOCK_TIMEOUT,
    value = Timeouts.SKIP_LOCKED_MILLI + ""
))
public @interface SkipLocked {}
```

Much cleaner. Now the repository reads like intent, not plumbing:

```java
@SkipLocked
@Lock(LockModeType.PESSIMISTIC_WRITE)
Optional<ReportGenerationEntity> findFirstByStateOrderByCreatedAt(TaskState state);
```

You *can* keep the lock while processing by wrapping the whole fetch-execute-update cycle in a
single transaction, but you generally should not:

```java
// Technically works, but do not use this pattern for outbox processing.
@Transactional
public void fetchAndProcess() {
    repository.findFirstByStateOrderByCreatedAt(TaskState.PENDING)
            .ifPresent(task -> {
                generateReport(task);
                task.setState(TaskState.COMPLETED);
                repository.save(task);
            });
}
```

```mermaid
sequenceDiagram
    participant DB as PostgreSQL
    participant A as Worker A
    participant B as Worker B

    Note over DB: task row: PENDING (unlocked)

    par Worker A and Worker B fetch simultaneously
        A->>DB: SELECT ... FOR UPDATE SKIP LOCKED
        B->>DB: SELECT ... FOR UPDATE SKIP LOCKED
    end

    DB-->>A: row locked ✓ — returns task
    DB-->>B: row locked by A — SKIP LOCKED returns empty

    Note over B: no task found, exits cleanly

    A->>A: generateReport()
    A->>DB: UPDATE state = COMPLETED
    A->>DB: COMMIT — lock released

    Note over DB: task row: COMPLETED (unlocked)
```

Even if `generateReport()` is small enough that this technically works, running an outbox action
under an open transaction is an antipattern. Transaction duration should not depend on outbox
execution duration: the action can become slower over time, block on I/O, or call a downstream
service, leaving a database connection and row lock held for an unpredictable period.

Instead, claim the row in a short transaction by moving it to `PROCESSING`, commit and release the
lock, and only then execute the outbox action. Record `COMPLETED` or `FAILED` in another short
transaction afterward. The next section implements that state transition and its recovery path.

### Never Talk to the Outside World Inside a Transaction

The same rule applies far beyond the outbox worker, and it's the single most common way I've seen
outbox-adjacent code take a service down. It looks harmless:

```java
// ❌ Kafka send (or an HTTP call, or an S3 upload) inside an open DB transaction
@Transactional
public void approveOrder(UUID orderId) {
    var order = orderRepository.findById(orderId).orElseThrow();
    order.setStatus(OrderStatus.APPROVED);

    kafkaTemplate.send("order-approved", orderId.toString(), toEvent(order)).get(); // blocks
    billingClient.notifyApproved(orderId);                                         // blocks
}
```

On a good day Kafka acks in 5ms and the billing service answers in 30ms, so nobody notices. On a
bad day the broker is rebalancing or the billing service is degraded, and every call takes 30
seconds before it times out. Now **every** in-flight transaction is open for 30 seconds:

- each one holds a pooled connection — with 20 connections and 30-second calls, your whole service
  can approve 20 orders per 30 seconds, and everything else (including healthy read endpoints)
  queues for the pool and starts timing out;
- each one holds row locks — anything that touches the same orders waits behind them;
- each one pins an old snapshot — Postgres can't vacuum past it, so bloat builds up across the
  whole database, not just this table.

A degradation in a dependency you don't own just became an outage in a database you do own. **The
duration of a database transaction must never depend on an external resource.** The transaction
should only ever wait on the database itself.

It is also still a dual write. If the Kafka send succeeds and the commit then fails (constraint
violation, serialization failure, the pod is killed), consumers have already seen an
`order-approved` event for an order that was never approved. Moving the send *after* the commit
just flips the failure mode: committed, but the event is lost. This is exactly the problem the
outbox exists to solve — write the intent to the outbox in the transaction, and let a worker talk
to Kafka afterwards.

Two guards are worth adding even when the code is correct, because the next person to touch it
may not know the rule:

```java
@Transactional(timeout = 5) // seconds
public void approveOrder(UUID orderId) { ... }
```

Spring's `timeout` does not interrupt a call that is already blocked — it is a deadline checked by
the database work that follows. Any statement issued after the deadline (including the flush at
commit) fails with `TransactionTimedOutException` and the transaction rolls back. Treat it as a
tripwire that turns "slow and silent" into "fails loudly in tests and logs", not as a cure.

```sql
-- server-side safety net: kill sessions that sit idle inside an open transaction
ALTER DATABASE app SET idle_in_transaction_session_timeout = '30s';
```

`idle_in_transaction_session_timeout` is exactly the situation above from Postgres' point of view:
the session opened a transaction and then went quiet while the application waited on something
else.

---

## Part 2.5 — Reducing Latency with Application Events

The polling scheduler has an inherent latency floor. If your job fires every second, a task
submitted at `t=0ms` sits `PENDING` until the next tick — up to 1000ms later. For most async
workloads that's acceptable. For cases where you want near-immediate pickup — sending a
transactional email, triggering a webhook — it's not.

The pattern borrowed from Celery: save the outbox entity to the database, then immediately
publish a Spring `ApplicationEvent` carrying the new task's ID. A listener picks it up and
dispatches processing right away, without waiting for the next scheduler tick.

```mermaid
sequenceDiagram
    participant S as Service
    participant DB as PostgreSQL
    participant EL as Event Listener
    participant W as Worker

    rect rgb(240, 240, 240)
        Note over S,W: Polling approach — up to 1s latency
        S->>DB: INSERT task (PENDING)
        Note over W: ... waiting for next scheduler tick (0–1000ms) ...
        W->>DB: SELECT PENDING tasks
        DB-->>W: task found
        W->>W: process task
    end

    rect rgb(230, 247, 240)
        Note over S,W: Application event approach — near-zero latency
        S->>DB: INSERT task (PENDING)
        S->>EL: publishEvent(taskId) — fires AFTER_COMMIT
        EL->>W: trigger fetchAndProcess() immediately
        W->>DB: SELECT PENDING tasks
        DB-->>W: task found
        W->>W: process task
    end
```

The scheduler still runs as a safety net — it catches anything the event listener missed (app
restart, listener exception, missed event). But the happy path bypasses the polling delay
entirely.

### Implementation

Publish the event inside the service method, after saving:

```java
@Service
@RequiredArgsConstructor
public class ReportGenerationService {

    private final ReportGenerationRepository repository;
    private final ApplicationEventPublisher eventPublisher;

    @Transactional
    public void submit(ReportGenerationCommand command) {
        var entity = repository.save(ReportGenerationEntity.builder()
                .state(TaskState.PENDING)
                .payload(ReportGenerationPayload.builder()
                        .from(command.getFrom())
                        .to(command.getTo())
                        .build())
                .build());

        eventPublisher.publishEvent(new ReportGenerationTaskSubmittedEvent(entity.getId()));
    }
}
```

```java
public record ReportGenerationTaskSubmittedEvent(UUID taskId) {}
```

The listener reacts after the commit, **on its own thread pool**:

```java
@Component
@RequiredArgsConstructor
public class ReportGenerationTaskEventListener {

    private final ReportGenerationTaskService taskService;

    @Async("outboxExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onTaskSubmitted(ReportGenerationTaskSubmittedEvent event) {
        taskService.fetchAndProcess();
    }
}
```

`@Async` is not decoration. An `AFTER_COMMIT` listener without it runs **synchronously on the
thread that committed** — the HTTP request thread. The user's "202 Accepted" now waits for the
whole report to be generated. Worse, at that point the committed transaction's resources are
still bound to the thread: Spring's own documentation warns that data access from an
after-commit callback still "participates" in the finished transaction, and nothing will commit
it unless the code explicitly asks for `REQUIRES_NEW`. Moving the listener onto a separate thread
fixes both at once.

### A Dedicated Thread Pool, Not the Default One

`@Async` without a name uses Spring Boot's shared `applicationTaskExecutor` — shared with every
other `@Async` method in the app, and with an effectively unbounded queue by default. An event
flood would quietly turn into an in-memory backlog that disappears on the next restart. Give the
outbox its own bounded pool:

```java
@Configuration
@EnableAsync
public class OutboxExecutorConfig {

    @Bean("outboxExecutor")
    public ThreadPoolTaskExecutor outboxExecutor() {
        var executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(4);
        executor.setQueueCapacity(200);                 // bounded: overflow is rejected, not buffered forever
        executor.setThreadNamePrefix("outbox-");        // readable thread dumps and logs
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.DiscardPolicy());
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);
        return executor;
    }
}
```

Discarding on overflow is safe here *because the row is in the database*: the event is only a
latency optimisation, and the poller picks up anything the event path dropped. Never use
`CallerRunsPolicy` for this pool — the "caller" is the request thread you were trying to free.

### The Classic Mistake

The most common error is using `@EventListener` instead of
`@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)`. What goes wrong depends on
whether the listener is asynchronous:

- **Plain `@EventListener`** fires the moment `publishEvent()` is called — synchronously, on the
  same thread, **inside the still-open transaction**. `fetchAndProcess()` joins that transaction,
  so it *does* see the uncommitted row — and it claims and runs the task right there. The report
  is generated inside the submit transaction (the exact antipattern from Part 2), the request
  hangs until it finishes, and if the submit transaction then rolls back, you have executed a
  task that officially never existed.
- **`@Async` + `@EventListener`** runs on another thread with another connection, before the
  commit. The row is not visible yet, the fetch finds nothing, and the event is silently wasted.
  The scheduler picks the task up a second later, so the logs look fine — you have just lost the
  latency benefit without noticing.

```java
// ❌ fires inside the open transaction (or before it commits, if @Async)
@EventListener
public void onTaskSubmitted(ReportGenerationTaskSubmittedEvent event) {
    taskService.fetchAndProcess();
}

// ✅ fires after COMMIT, on the outbox pool — the row is visible and the caller is free
@Async("outboxExecutor")
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onTaskSubmitted(ReportGenerationTaskSubmittedEvent event) {
    taskService.fetchAndProcess();
}
```

The scheduler remains unchanged — it acts as the recovery mechanism for any tasks the event
listener missed. The two approaches complement each other: events for latency, polling for
reliability.

### Going Further: the Zero-Select Outbox

The event above still costs a round trip. It only says "something new arrived", so the worker has
to `SELECT` to find out what — and with `ORDER BY created_at` it may not even pick the task that
triggered it. When latency really matters, skip the read altogether: **put everything needed to
execute the task into the event**, execute it straight from memory, and write back only the
result.

```mermaid
sequenceDiagram
    participant S as Service
    participant DB as PostgreSQL
    participant X as outboxExecutor

    S->>DB: INSERT task (PROCESSING, heartbeat_at = now)
    S->>DB: COMMIT
    S-)X: event(taskId, payload) — AFTER_COMMIT
    X->>X: generateReport(payload)
    X->>DB: UPDATE state = COMPLETED WHERE id = ?
    Note over DB,X: no SELECT anywhere on the happy path
```

This uses the `PROCESSING` state and heartbeat from Parts 3 and 5. The row is inserted already
`PROCESSING`, with a fresh `heartbeat_at` acting as a lease. That detail is what keeps it correct:
if the row were inserted `PENDING`, the poller could claim it while the event path is already
executing it, and the task would run twice.

```java
public record ReportRequestedEvent(UUID taskId, ReportGenerationPayload payload) {}

@Transactional
public void submit(ReportGenerationCommand command) {
    var payload = ReportGenerationPayload.builder()
            .from(command.getFrom())
            .to(command.getTo())
            .build();
    var entity = repository.save(ReportGenerationEntity.builder()
            .state(TaskState.PROCESSING)
            .heartbeatAt(Instant.now())   // lease: the poller leaves this row alone
            .payload(payload)
            .build());
    eventPublisher.publishEvent(new ReportRequestedEvent(entity.getId(), payload));
}
```

```java
@Async("outboxExecutor")
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onReportRequested(ReportRequestedEvent event) {
    try (var heartbeat = heartbeatFactory.start(event.taskId())) {
        generateReport(event.payload());
        repository.markCompleted(event.taskId());              // UPDATE ... WHERE id = :id
    } catch (Exception e) {
        repository.markFailed(event.taskId(), e.getMessage()); // the poller retries it later
    }
}
```

Every failure mode lands back in the classic path. If the listener throws, the task is `FAILED`
and the poller retries it with backoff. If the app dies mid-execution, the heartbeat stops and the
stuck-task recovery job resets it. If the pool rejects the event, the row sits as `PROCESSING`
with a lease that is never renewed — either flip it back to `PENDING` in the rejection handler
(one `UPDATE` by id) or accept that it waits for recovery. That last case is why the zero-select
path wants a short recovery threshold.

**The trade-off: who controls the amount of work.** A polling outbox *pulls*. It decides how many
tasks to take and how fast, so its load is bounded by design no matter what happens upstream. A
zero-select outbox is *pushed*: work arrives at the rate requests arrive. A traffic spike becomes
an execution spike, and the only brakes are the pool size and the queue capacity — once they are
full you are rejecting and falling back to polling anyway. Use zero-select for latency-sensitive,
moderate-volume work with a bounded pool; keep the poller for everything else, and always as the
safety net.

**Squeezing out the last write.** For maximum throughput you can go one step further and stop
writing each completion individually: collect completed ids in memory and flush them as one
`UPDATE` every few hundred milliseconds.

```java
@Component
@RequiredArgsConstructor
public class CompletionBuffer {

    private final ConcurrentLinkedQueue<UUID> completed = new ConcurrentLinkedQueue<>();
    private final ReportGenerationRepository repository;

    public void add(UUID taskId) {
        completed.add(taskId);
    }

    @Scheduled(fixedDelay = 200)
    @PreDestroy                                   // flush what we can on a graceful shutdown
    public void flush() {
        var ids = new ArrayList<UUID>();
        for (UUID id; ids.size() < 1_000 && (id = completed.poll()) != null; ) {
            ids.add(id);
        }
        if (!ids.isEmpty()) {
            repository.markCompleted(ids);        // UPDATE ... SET state = 'COMPLETED' WHERE id IN (:ids)
        }
    }
}
```

Be precise about what this costs. A crash loses the buffer — not the tasks, but the *record that
they finished*. Those rows stay `PROCESSING`, recovery resets them, and they execute **again**.
That is only acceptable when every handler is idempotent (Part 10). Write failures immediately
rather than buffering them: they are rare, and their error message is the one thing you can't
reconstruct later.

---

## Part 3 — Failures, Retries, and the PROCESSING State

```mermaid
stateDiagram-v2
    [*] --> PENDING: submit()

    PENDING --> PROCESSING: worker claims task<br/>(TX1 commits)

    PROCESSING --> COMPLETED: generateReport() succeeds<br/>(TX2 commits)
    PROCESSING --> FAILED: generateReport() throws<br/>(TX2 commits)
    PROCESSING --> PENDING: app crash detected<br/>stuck-task recovery job resets

    FAILED --> PROCESSING: retry eligible<br/>(retryCount ≤ MAX and executeAt ≤ now)
    FAILED --> [*]: retryCount > MAX<br/>(dead — manual ops)

    COMPLETED --> [*]: cleanup job removes<br/>after retention period
```

Outbox actions should not run under an open database transaction. The locked-transaction approach
holds a database lock for the entire
duration of `generateReport()`. For a report that takes two minutes, that's two minutes of a
locked row — a connection tied up, other DB operations potentially queuing behind it. With
`SKIP LOCKED` workers don't block each other on the lock, but long-running transactions still
put pressure on the connection pool and make the database unhappy under load. A very small action
may technically complete without causing visible trouble, but coupling transaction duration to
outbox execution duration is still an antipattern.

The fix is to separate claiming a task from executing it. Flip the task to `PROCESSING` in a
short transaction, release the lock, then do the actual work outside any transaction. This way
the DB is only touched briefly at the start and briefly at the end — the expensive part happens
in between without holding anything.

First, extend the enum:

```sql
ALTER TYPE task_state ADD VALUE 'PROCESSING';
ALTER TYPE task_state ADD VALUE 'FAILED';

ALTER TABLE report_generation_tasks
    ADD COLUMN retry_count  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN error_message VARCHAR;
```

`retry_count` tracks how many times execution was attempted. We cap retries at 10 — beyond that,
something is genuinely broken and needs manual intervention. We'll wire alerting around this
later. `error_message` stores the last exception so you know *why* a task is stuck without
digging through logs.

The Java enum grows with it:

```java
public enum TaskState {
    PENDING,
    PROCESSING,
    COMPLETED,
    FAILED
}
```

The service now runs two separate short transactions with the actual work in between:

```java
@RequiredArgsConstructor
public class ReportGenerationTaskService {

    private final ReportGenerationRepository repository;
    private final TransactionTemplate transactionTemplate;

    private static final int MAX_RETRY_COUNT = 10;

    public void fetchAndProcess() {
        transactionTemplate
                .execute(status ->
                        repository.findFirstEligibleTask(
                                List.of(TaskState.PENDING, TaskState.FAILED),
                                MAX_RETRY_COUNT
                        ).map(this::markProcessing))
                .ifPresentOrElse(
                        task -> {
                            try {
                                generateReport(task);
                                markCompleted(task);
                            } catch (Exception e) {
                                markFailed(task, e);
                                log.error("Task {} failed on attempt {}", task.getId(), task.getRetryCount(), e);
                            }
                        },
                        () -> log.debug("No eligible tasks to process")
                );
    }

    private ReportGenerationEntity markProcessing(ReportGenerationEntity task) {
        task.setState(TaskState.PROCESSING);
        return repository.save(task);
    }

    private void markCompleted(ReportGenerationEntity task) {
        task.setState(TaskState.COMPLETED);
        repository.save(task);
    }

    private void markFailed(ReportGenerationEntity task, Exception e) {
        task.setState(TaskState.FAILED);
        task.setRetryCount(task.getRetryCount() + 1);
        task.setErrorMessage(e.getMessage()); // don't skip this — it's the only trace of what went wrong without digging through logs
        repository.save(task);
    }
}
```

The query fetches both `PENDING` and `FAILED` tasks — a failed task with `retryCount < 10` is
just as eligible as a fresh one. Once retry count hits the cap, the task stops being fetched and
sits as a permanent `FAILED` record until someone looks at it. That's intentional — beyond 10
attempts something is genuinely broken and needs eyes on it, not another retry.

```java
@SkipLocked
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("""
    SELECT t FROM ReportGenerationEntity t
    WHERE t.state IN :states
      AND t.retryCount < :maxRetryCount
    ORDER BY t.createdAt ASC
    LIMIT 1
    """)
Optional<ReportGenerationEntity> findFirstEligibleTask(
    @Param("states") List<TaskState> states,
    @Param("maxRetryCount") Integer maxRetryCount
);
```

But wait — should a just-failed task really be picked up again on the very next scheduler tick,
seconds later? If the downstream system is down, hammering it every second makes things worse.
That's what the next section covers.

## Part 4 — Exponential Backoff

Without a delay between retries, a failed task re-enters the queue on the very next scheduler
tick — usually seconds later. If the downstream system is down, you're hammering it at full
polling rate. That's bad for the downstream system and bad for your DB.

The fix is an `execute_at` column: the task is not eligible until this timestamp is in the past.
Fresh tasks get `execute_at = now()` so they're picked up immediately. Failed tasks get
`execute_at = now() + delay`, where the delay grows with each retry.

```sql
ALTER TABLE report_generation_tasks
    ADD COLUMN execute_at TIMESTAMP NOT NULL DEFAULT NOW();
```

The delay schedule drives everything — `MAX_RETRY_COUNT` is derived from it, not declared
separately. This way the two can never drift out of sync:

```java
private static final Map<Integer, Duration> RETRY_DELAYS = Map.of(
    0, Duration.ofMinutes(1),
    1, Duration.ofMinutes(5),
    2, Duration.ofMinutes(15),
    3, Duration.ofMinutes(30),
    4, Duration.ofHours(1),
    5, Duration.ofHours(2),
    6, Duration.ofHours(4),
    7, Duration.ofHours(8),
    8, Duration.ofHours(12),
    9, Duration.ofDays(1)
);

private static final int MAX_RETRY_COUNT = RETRY_DELAYS.size();
```

Add a new entry to `RETRY_DELAYS` and the retry cap automatically updates. No magic number to
keep in sync elsewhere.

In `markFailed()`, capture the *current* retry count before incrementing — that selects the
delay for the *next* attempt:

```java
private void markFailed(ReportGenerationEntity task, Exception e) {
    int currentRetry = task.getRetryCount();
    task.setState(TaskState.FAILED);
    task.setRetryCount(currentRetry + 1);
    task.setErrorMessage(e.getMessage());
    task.setExecuteAt(Instant.now().plus(
            RETRY_DELAYS.getOrDefault(currentRetry, RETRY_DELAYS.get(RETRY_DELAYS.size() - 1))));
    repository.save(task);
}
```

The fetch query gains one condition — `AND t.executeAt <= :now` — and the scheduler keeps running
at the same rate. It just skips tasks whose window hasn't opened. Failed tasks sit quietly until
their time comes, then re-enter naturally.

### Jitter: Flatten the Load Before It Hits You

A fixed backoff schedule has a nasty property: tasks that failed together retry together. If the
email provider was down for two minutes, the 3,000 tasks that failed in that window all get
`execute_at = failed_at + 1 minute` — and hit the provider again as one synchronized wave the
moment it comes back. Add randomness to every delay so the wave spreads out:

```java
private static Instant nextAttempt(Duration baseDelay) {
    long jitterMillis = ThreadLocalRandom.current().nextLong(baseDelay.toMillis() / 2 + 1);
    return Instant.now().plus(baseDelay).plusMillis(jitterMillis); // base + up to 50%
}
```

The same idea applies on the way **in**. Architecturally, an async engine wants a flat, steady
load — not big, sudden spikes. A nightly import that submits 200,000 tasks in one transaction
makes all of them eligible at the same millisecond; every worker on every pod saturates, the
downstream system gets the full burst, and your latency dashboards light up for work that nobody
was waiting for. When a task is not urgent, give it a jittered `execute_at` at submit time:

```java
// bulk / non-urgent submission: spread over the next 10 minutes instead of "all now"
entity.setExecuteAt(Instant.now().plusMillis(
        ThreadLocalRandom.current().nextLong(Duration.ofMinutes(10).toMillis())));
```

The total amount of work is unchanged; it is just spread out over time. User-facing tasks keep
`execute_at = now()`; batch work gets a jitter window sized to how long it can afford to wait.

---

## Part 5 — Stuck Tasks and Heartbeats

```mermaid
sequenceDiagram
    participant W as Worker
    participant DB as PostgreSQL
    participant R as Recovery Job

    W->>DB: UPDATE state = PROCESSING (TX1 commits)
    W->>W: generateReport() — running...

    Note over W: 💥 app crashes mid-execution

    Note over DB: task stuck in PROCESSING<br/>heartbeat_at stops updating

    loop Recovery job runs every 5 min
        R->>DB: SELECT WHERE state = PROCESSING<br/>AND heartbeat_at < now() - 1h
        DB-->>R: stuck task found
        R->>DB: UPDATE state = PENDING
        Note over DB: task back in queue — will be retried
    end
```

With the two-transaction approach, consider what happens if the app crashes after marking a task
`PROCESSING` but before marking it `COMPLETED` or `FAILED`. The DB shows `PROCESSING`. Nobody is
processing it. It sits there forever.

The naive fix is a recovery job that finds tasks stuck in `PROCESSING` for too long and resets
them to `PENDING`:

```java
@Transactional
public void recoverStuckTasks() {
    repository.findFirstByStateAndUpdatedAtLessThan(
                    TaskState.PROCESSING,
                    Instant.now().minus(1, ChronoUnit.HOURS))
            .ifPresent(task -> {
                log.warn("Resetting stuck task {} to PENDING", task.getId());
                task.setState(TaskState.PENDING);
                repository.save(task);
            });
}
```

This works for most cases. The problem: `updated_at` changes whenever *anything* changes on the
row — including unrelated state transitions. A task legitimately processing for 55 minutes looks
identical to a crashed task from the `updated_at` perspective.

The cleaner solution is a **heartbeat**: a dedicated column that gets bumped periodically *only
while the task is being actively processed*. The recovery job now checks this column, not
`updated_at`. A task that hasn't heartbeated in the last hour is genuinely stuck.

```sql
ALTER TABLE report_generation_tasks ADD COLUMN heartbeat_at TIMESTAMP;
```

The heartbeat runs on its own thread, inside its own transactions, independent of the processing
logic. The cleanest implementation is a `try-with-resources` — it starts when processing starts
and stops on any exit path:

```java
public abstract class Heartbeat implements AutoCloseable {

    private final ScheduledExecutorService executor;

    protected Heartbeat(Runnable heartbeatFn) {
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleAtFixedRate(heartbeatFn, 0, 10, TimeUnit.SECONDS);
    }

    @Override
    public void close() {
        executor.shutdownNow();
    }
}
```

```java
public class ReportGenerationTaskHeartbeat extends Heartbeat {

    ReportGenerationTaskHeartbeat(UUID taskId, ReportGenerationRepository repository) {
        super(() -> repository.updateHeartbeatAt(taskId, Instant.now()));
    }
}
```

The repository method carries its own `@Transactional` — no need to wrap the call manually:

```java
@Modifying
@Transactional
@Query("UPDATE ReportGenerationEntity t SET t.heartbeatAt = :now WHERE t.id = :id")
void updateHeartbeatAt(@Param("id") UUID id, @Param("now") Instant now);
```

Wire it via a factory so the service stays clean:

```java
@Component
@RequiredArgsConstructor
public class ReportGenerationTaskHeartbeatFactory {

    private final ReportGenerationRepository repository;

    public Heartbeat start(UUID taskId) {
        return new ReportGenerationTaskHeartbeat(taskId, repository);
    }
}
```

The processing block now looks like this:

```java
public void fetchAndProcess() {
    transactionTemplate
            .execute(status -> repository.findFirstEligibleTask(
                    List.of(TaskState.PENDING, TaskState.FAILED),
                    MAX_RETRY_COUNT
            ).map(this::markProcessing))
            .ifPresentOrElse(
                    task -> {
                        try (var heartbeat = heartbeatFactory.start(task.getId())) {
                            try {
                                generateReport(task);
                                markCompleted(task);
                            } catch (Exception e) {
                                markFailed(task, e);
                                log.error("Task {} failed", task.getId(), e);
                            }
                        }
                    },
                    () -> log.debug("No eligible tasks to process")
            );
}
```

The recovery job uses `heartbeat_at` instead of `updated_at`:

```java
@Modifying
@Transactional
@Query("UPDATE ReportGenerationEntity t SET t.heartbeatAt = :now WHERE t.id = :id")
void updateHeartbeatAt(@Param("id") UUID id, @Param("now") Instant now);

Optional<ReportGenerationEntity> findFirstByStateAndHeartbeatAtLessThan(
        TaskState state, Instant threshold);
```

`updated_at` reflects when the task state last changed. `heartbeat_at` reflects whether the
task is alive right now. Keeping them separate means you can answer both questions without
ambiguity.

---

## Part 6 — Multi-Type Outbox

```mermaid
flowchart TB
    subgraph before["❌ Before — separate table per type"]
        direction TB
        W1[ReportWorker] --> T1[(report_generation_tasks)]
        W2[EmailWorker]  --> T2[(email_notification_tasks)]
        W3[WebhookWorker]--> T3[(webhook_delivery_tasks)]
    end

    before --> after

    subgraph after["✅ After — one table, handler per type"]
        direction TB
        OT[(outbox_tasks<br/>task_type column)] --> D[Dispatcher]
        D --> H1[ReportHandler]
        D --> H2[EmailHandler]
        D --> H3[WebhookHandler]
    end
```

Six months in, your service handles more than report generation. You need email notifications.
Then data exports. Then webhook deliveries.

You have two options: a separate table per task type, or one shared table with a `task_type`
discriminator. The shared table wins when task types are numerous and you're comfortable
processing them from one place. The infrastructure — retries, heartbeats, backoff, monitoring —
stays in one place. Adding a new task type is just adding a new handler.

The tradeoffs worth knowing upfront:

- A misbehaving new task type can slow down all other types — one bad handler burning retries
  creates backpressure across the whole table.
- Ordering guarantees become harder — more on this below.

### The Schema

```sql
CREATE TYPE outbox_task_type AS ENUM ('REPORT_GENERATION', 'EMAIL_NOTIFICATION');

CREATE TABLE outbox_tasks (
    id            UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type     outbox_task_type NOT NULL,
    state         task_state       NOT NULL    DEFAULT 'PENDING',
    payload       JSONB            NOT NULL,
    retry_count   INTEGER          NOT NULL    DEFAULT 0,
    error_message VARCHAR,
    execute_at    TIMESTAMPTZ      NOT NULL    DEFAULT NOW(),
    heartbeat_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ      NOT NULL    DEFAULT now(),
    updated_at    TIMESTAMPTZ      NOT NULL    DEFAULT now()
);
```

### The Handler Interface

The key extensibility point — one implementation per task type:

```java
public interface OutboxTaskHandler<P> {
    OutboxTaskType getType();
    Class<P> payloadClass();
    void handle(UUID taskId, P payload) throws Exception;
}
```

`taskId` is passed into every handler. You'll see why in the idempotency section.

A concrete handler:

```java
@Component
public class EmailNotificationHandler implements OutboxTaskHandler<EmailNotificationPayload> {

    @Override
    public OutboxTaskType getType() {
        return OutboxTaskType.EMAIL_NOTIFICATION;
    }

    @Override
    public Class<EmailNotificationPayload> payloadClass() {
        return EmailNotificationPayload.class;
    }

    @Override
    public void handle(UUID taskId, EmailNotificationPayload payload) throws Exception {
        log.info("Sending email to {} — task {}", payload.getRecipient(), taskId);
        // call email provider
    }
}
```

### The Dispatcher

The service collects all handler beans at startup, builds a lookup map, and routes each task by
`taskType`:

```java
@Service
@RequiredArgsConstructor
public class OutboxTaskService {

    private final OutboxTaskRepository repository;
    private final ObjectMapper objectMapper;
    private final List<OutboxTaskHandler<?>> handlerList;

    private Map<OutboxTaskType, OutboxTaskHandler<?>> handlers;

    @PostConstruct
    void init() {
        handlers = handlerList.stream()
                .collect(Collectors.toMap(OutboxTaskHandler::getType, Function.identity()));
    }

    @SuppressWarnings("unchecked")
    private void dispatch(OutboxTaskEntity task) throws Exception {
        var handler = (OutboxTaskHandler<Object>) handlers.get(task.getTaskType());
        if (handler == null) {
            throw new IllegalStateException(
                    "No handler registered for task type: " + task.getTaskType());
        }
        var payload = objectMapper.readValue(task.getPayload(), handler.payloadClass());
        handler.handle(task.getId(), payload);
    }
}
```

Registering a new task type is: add enum value, add handler bean, done. The dispatcher, the
scheduler, the retry logic — none of it changes.

---

## Part 7 — Ordering

If your use case doesn't care about processing order — fire-and-forget notifications, independent
background jobs — skip this section. But even then, fetching earlier-inserted tasks first is the
more honest behaviour: tasks submitted first have been waiting longer, and processing them in
submission order is what users would reasonably expect.

Without an explicit `ORDER BY`, PostgreSQL makes **no guarantee** about row return order. Always
sort by `created_at ASC` in your fetch query:

```java
@Query("""
    SELECT t FROM OutboxTaskEntity t
    WHERE t.state IN :states
      AND t.retryCount < :maxRetryCount
      AND t.executeAt <= :now
    ORDER BY t.createdAt ASC
    LIMIT 1
    """)
Optional<OutboxTaskEntity> findFirstEligibleTask(...);
```

Back this with a partial index:

```sql
CREATE INDEX idx_outbox_fetch
    ON outbox_tasks (created_at ASC)
    WHERE state IN ('PENDING', 'FAILED');
```

### The Clock Skew Trap

First, be honest about whether this matters for your use case. If your tasks are independent —
report generation, email sending, webhook delivery — processing order usually doesn't matter at
all. Task A finishing before task B is fine regardless of which was submitted first. In that case
this whole section is not your problem.

If you do need FIFO — tasks for the same entity that must be processed in submission order —
then read on.

The issue is that `created_at` is generated on the application side. Each app instance has its
own system clock. If instance A is 200ms ahead of instance B, a task submitted by B at `t=100ms`
gets a `created_at` that is earlier than a task submitted by A at `t=50ms` — even though A's
task was inserted first. The fetch query sorts by `created_at` and picks up B's task first.
Submission order is inverted.

NTP keeps clocks close but not perfectly synchronized. Under normal conditions the drift is
milliseconds. Under load, during VM migrations, or after a container restart, it can be more.

The fix is to generate the ordering value on the database side — either let PostgreSQL assign
`created_at` via `DEFAULT now()` rather than letting the application set it, or use a
database-backed sequence which is guaranteed monotonically increasing regardless of which
instance inserted the row. Here's the sequence approach:

```sql
ALTER TABLE outbox_tasks ADD COLUMN seq BIGSERIAL;
```

```java
@Column(insertable = false, updatable = false)
private Long seq;
```

Sort by `seq ASC`. The value is assigned by a single authoritative source — the database — so
it reflects true insertion order regardless of which instance submitted the task or what that
instance's clock said.

Keep `created_at` for observability. Use `seq` for ordering.

One caveat that bites people who rely on this too hard: a sequence value is assigned at `INSERT`,
not at `COMMIT`. Transaction A can take `seq = 100`, transaction B takes `seq = 101` and commits
first — for a moment the worker sees 101 but not 100. `seq` gives you a stable, clock-independent
order; it does not, on its own, give you "never process 101 before 100". If that is a hard
requirement for one entity, process that entity's tasks one at a time (for example, skip a task
while an older task for the same key is still `PENDING` or `PROCESSING`).

If strict FIFO matters in your system — don't forget this.

---

## Part 7.5 — Fetch Strategies: When to Poll and How Much to Take

So far the worker has been a `@Scheduled(fixedDelay = 1000)` that takes one task per tick. That is
fine for a demo and almost never what you want in production. Two decisions matter: **what
triggers a run**, and **how much work one run takes**.

### What triggers a run

| Trigger | Spring | Behaviour | Good for |
|---|---|---|---|
| Fixed delay | `@Scheduled(fixedDelay = 1000)` | next run starts N ms *after the previous one finished* | most outboxes — load-aware by design |
| Fixed rate | `@Scheduled(fixedRate = 1000)` | runs are *scheduled* every N ms, regardless of how long they take | steady-cost jobs (metrics, heartbeats) |
| Cron | `@Scheduled(cron = "0 */5 * * * *")` | wall-clock times | cleanup, reports, anything tied to "nightly" |
| Threshold | your own trigger | run when backlog ≥ N rows or the oldest task is older than T | downstreams that prefer batches (bulk APIs) |

Choosing between them is not cosmetic. With `fixedRate`, a run that takes longer than the period
is followed **immediately** by the next one, so a slow downstream turns a 1-second poller into a
tight loop that never rests. With `fixedDelay`, a slow run simply pushes the next run back — the
worker naturally slows down when the system is struggling.

### Can two runs overlap?

Within **one** Spring instance, the same `@Scheduled` method does not run concurrently with
itself — even with `fixedRate`, a late run waits for the previous one to finish. That reassurance
is where many people stop, and it is the wrong place to stop. Runs *do* overlap when:

- you run **more than one pod** — which is every production deployment; N pods are N concurrent
  workers;
- the scheduled method is `@Async`, or hands work to an executor and returns immediately;
- you use Quartz without `@DisallowConcurrentExecution`;
- you use a Kubernetes `CronJob` — its default `concurrencyPolicy` is `Allow`, so a run that
  outlives its schedule gets a sibling.

For the fetch-and-process path this is fine — that's what `SKIP LOCKED` is for; overlapping
workers just split the work, at the cost of some extra queries. It is **not** fine for jobs
that aren't built for it: two cleanup jobs deleting the same range wait on each other's locks;
two stuck-task recovery jobs can both reset the same task. For those singleton jobs, take a
lock first — ShedLock, or a Postgres advisory lock:

```java
@Scheduled(fixedDelay = 60_000)
@SchedulerLock(name = "outbox-cleanup", lockAtMostFor = "10m")
public void cleanup() { ... }
```

### How much one run takes: the drain loop

Taking one task per tick caps throughput at one task per second per pod, no matter how much
capacity you have. Taking a batch is better; better still is a run that **keeps fetching until
the queue is drained**, and only then ends its tick:

```mermaid
flowchart TD
    T([tick starts]) --> F[claim up to N tasks<br/>FOR UPDATE SKIP LOCKED]
    F --> E{got any?}
    E -- no --> D([tick ends<br/>wait fixedDelay])
    E -- yes --> P[process batch]
    P --> L{time budget<br/>left?}
    L -- yes --> F
    L -- no --> D
```

When the queue is empty, a tick costs one cheap indexed query. When a backlog builds up, the
worker stops waiting between batches and runs at full speed until it catches up. The time budget
matters: without it, a tick under a sustained backlog never ends, which makes graceful shutdown
slow and starves any other job sharing the scheduler thread.

```java
@Scheduled(fixedDelay = 1000)
public void run() {
    var deadline = Instant.now().plus(Duration.ofSeconds(30));
    List<OutboxTaskEntity> batch;
    do {
        batch = repository.claimBatch(BATCH_SIZE, MAX_RETRY_COUNT);
        batch.forEach(this::processClaimedTask);
    } while (!batch.isEmpty() && Instant.now().isBefore(deadline));
}
```

Claim the batch in one statement — select, lock and mark `PROCESSING` in a single round trip:

```java
// no @Modifying: UPDATE ... RETURNING is read back like a SELECT
@Transactional
@Query(nativeQuery = true, value = """
    UPDATE outbox_tasks
       SET state = 'PROCESSING', heartbeat_at = now(), updated_at = now()
     WHERE id IN (
           SELECT id FROM outbox_tasks
            WHERE state IN ('PENDING', 'FAILED')
              AND retry_count < :maxRetryCount
              AND execute_at <= now()
            ORDER BY seq
            LIMIT :batchSize
              FOR UPDATE SKIP LOCKED)
    RETURNING *
    """)
List<OutboxTaskEntity> claimBatch(@Param("batchSize") int batchSize,
                                  @Param("maxRetryCount") int maxRetryCount);
```

Size the batch so that one batch finishes well within the heartbeat window, and remember that
`UPDATE ... RETURNING` does not guarantee the returned rows come back in `seq` order — sort the
list in memory if order matters.

---

## Part 8 — Indexes That Keep the Table Fast at Scale

Your outbox table is polled every second, often multiple times per second. Every row in it is
either active work (`PENDING`, `FAILED`, `PROCESSING`) or historical noise (`COMPLETED`). Without the
right indexes, each poll scans the entire table to find the handful of eligible rows.

The right tool is a **partial index** — one that only includes rows matching a predicate. When a
task transitions to `COMPLETED`, it falls out of the partial index automatically. The index stays
small forever, regardless of how many tasks the table has ever processed.

### The Fetch Index — the hot path

Index for the fetch query:

```sql
CREATE INDEX idx_outbox_fetch
    ON outbox_tasks (created_at ASC)
    WHERE state IN ('PENDING', 'FAILED');
```

To test it: inserted 50,000 rows with only 7 in `PENDING` state, enabled Hibernate SQL debug
logging to get the exact generated query in the console, ran `EXPLAIN ANALYZE` over that SQL:

```
Limit  (cost=0.14..27.50 rows=1 width=102) (actual time=0.082..0.084 rows=1 loops=1)
  ->  LockRows  (actual time=0.081..0.082 rows=1 loops=1)
        ->  Index Scan using idx_outbox_fetch on outbox_tasks
              (actual time=0.030..0.030 rows=1 loops=1)
Planning Time: 1.230 ms
Execution Time: 0.139 ms
```

0.03ms to find the oldest eligible task. The 49,993 `COMPLETED` rows were never read. Looks good to me.

Two more indexes for the other two background operations:

For the recovery job:

```sql
CREATE INDEX idx_outbox_stuck
    ON outbox_tasks (heartbeat_at ASC, created_at ASC)
    WHERE state = 'PROCESSING';
```

For the cleanup job:

```sql
CREATE INDEX idx_outbox_cleanup
    ON outbox_tasks (updated_at ASC)
    WHERE state = 'COMPLETED';
```

---

## Part 9 — Cleanup

Your outbox is an operational table. Every fetch query scans it. Old rows are dead weight.

The rule: only delete **`COMPLETED`** tasks. `FAILED` tasks are your audit trail. Leave them alone.
Handle them manually or via a separate ops process when needed.

```java
@Modifying
@Transactional
@Query("""
    DELETE FROM OutboxTaskEntity t
    WHERE t.state IN :states
      AND t.updatedAt < :before
    """)
int deleteByStateInAndUpdatedAtBefore(
    @Param("states") List<TaskState> states,
    @Param("before") Instant before
);
```

```java
private static final int CLEANUP_RETENTION_DAYS = 30;

@Transactional
public void cleanup() {
    var cutoff = Instant.now().minus(CLEANUP_RETENTION_DAYS, ChronoUnit.DAYS);
    int deleted = repository.deleteByStateInAndUpdatedAtBefore(
            List.of(TaskState.COMPLETED), cutoff);
    log.info("Cleanup: removed {} completed tasks older than {} days", deleted, CLEANUP_RETENTION_DAYS);
}
```

How long to retain: I've seen everything from 1 day to 3 months. If you're unsure — keep longer.
The cost of retaining old rows is a slightly larger table. The cost of deleting them too early
is losing your debugging history on the day you need it most.

---

## Part 10 — Idempotency: Making Retries Safe

Nothing in this architecture guarantees exactly-once execution. The task runs and the state
update to `COMPLETED` are two separate operations. If the app crashes after execution but before
the state update commits, the task will be retried. It will run again with the same inputs.

This is **at-least-once** delivery — it's the only guarantee available here. The question is
whether a duplicate execution causes harm.

If your task is inherently idempotent (generating the same report twice produces the same report),
you're done. If it has side effects (sends an email, charges a card), a duplicate is a problem.

The fix: use the outbox task's own `id` as an idempotency key inside the handler. The task ID is
stable across retries — it never changes for the same row. The handler checks whether work for
this ID was already recorded. If yes, it's a no-op.

In our case, report generation ends by inserting a row into `generated_reports` — that's the
record of work done. We add a `UNIQUE` constraint on `idempotency_key` so that even if two
instances race, only one INSERT wins. The other gets a constraint violation and treats it as a
successful no-op:

```sql
CREATE TABLE generated_reports (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key  UUID        NOT NULL,
    report_path      VARCHAR     NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL    DEFAULT now(),

    CONSTRAINT uq_generated_reports_idempotency_key UNIQUE (idempotency_key)
);
```

```java
@Component
@RequiredArgsConstructor
public class ReportGenerationHandler implements OutboxTaskHandler<ReportGenerationPayload> {

    private final GeneratedReportRepository reports;

    @Override
    public void handle(UUID taskId, ReportGenerationPayload payload) {
        if (reports.existsByIdempotencyKey(taskId)) {
            log.info("Report already generated for task {} — skipping", taskId);
            return;
        }

        var reportPath = runReportGeneration(payload);

        reports.save(GeneratedReport.builder()
                .idempotencyKey(taskId)
                .reportPath(reportPath)
                .build());
    }
}
```

If your task calls an external API instead of writing to the DB, check whether that API supports
idempotency keys — most payment processors and transactional email providers do. Pass the outbox
task ID as the idempotency key in whatever form the API requires (header, body field, query param).
The remote service handles deduplication on their end.

---

## Part 11 — Monitoring

The outbox runs silently in the background. When it works, nobody notices. When it breaks,
nobody notices that either — at least not immediately. Stuck tasks pile up. Downstream services
stop receiving events. By the time someone looks at logs it's been two hours.

Three signals cover the failure space completely, per the Google SRE model:

- **Latency** — how long does each task take from pick-up to completion? Spike here means the handler is slow or the DB is under pressure.
- **Throughput** — how many tasks per unit time are finishing? Drops to zero means the scheduler isn't running or no tasks are being claimed.
- **Error rate** — what fraction of attempts end in failure? Above ~5% means a downstream dependency is degraded and the retry backlog is growing.

<img src="{{ site.baseurl }}/assets/img/outbox-grafana-dashboard.png" alt="Grafana outbox dashboard" style="max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #e5e7eb;">

### Instrumentation

Add to `build.gradle.kts`:

```kotlin
implementation("org.springframework.boot:spring-boot-starter-actuator")
implementation("io.micrometer:micrometer-registry-prometheus")
```

Register the `@Timed` AOP aspect once:

```java
@Bean
public TimedAspect timedAspect(MeterRegistry registry) {
    return new TimedAspect(registry);
}
```

Keep metric names as constants and increment from a dedicated component — not scattered across
service methods:

```java
@Component
@RequiredArgsConstructor
public class OutboxMetrics {

  private static final String TASK_PROCESSED = "outbox.task.processed";
  private static final String OUTCOME_TAG    = "outcome";
  private static final String COMPLETED      = "completed";
  private static final String FAILED         = "failed";

  private final MeterRegistry meterRegistry;
  private final ReportGenerationRepository repository;

  public void recordCompleted() {
    meterRegistry.counter(TASK_PROCESSED, OUTCOME_TAG, COMPLETED).increment();
  }

  public void recordFailed() {
    meterRegistry.counter(TASK_PROCESSED, OUTCOME_TAG, FAILED).increment();
  }

  @PostConstruct
  void registerGauge() {
    Gauge.builder("outbox.tasks.pending", repository,
                    repo -> repo.countByStateIn(List.of(TaskState.PENDING, TaskState.FAILED)))
            .description("Tasks waiting to be processed")
            .register(meterRegistry);
  }
}
```

The service then just calls `metrics.recordCompleted()` and `metrics.recordFailed()` — no raw
strings in business logic.

After startup, `curl localhost:8080/actuator/prometheus | grep outbox` gives you:

```
outbox_task_duration_seconds{quantile="0.5"}  0.062
outbox_task_duration_seconds{quantile="0.95"} 0.145
outbox_task_duration_seconds{quantile="0.99"} 0.312
outbox_task_processed_total{outcome="completed"} 40.0
outbox_task_processed_total{outcome="failed"}    2.0
outbox_tasks_pending 0.0
```

### Alerts

Dashboards are for humans watching screens. Alerts are for humans who are asleep.

| Alert | Fires when | For | Meaning |
|---|---|---|---|
| `OutboxQueueBacklog` | pending > 50 | 5m | Processing can't keep up with ingest |
| `OutboxHighErrorRate` | error rate > 5% | 2m | Handler or downstream degraded |
| `OutboxSlowProcessing` | p99 latency > 30s | 5m | DB contention or slow external call |
| `OutboxStuckTasks` | pending > 0 and zero completions in 10m | 10m | Scheduler crashed or all workers stuck |

Tune thresholds to your own load. A queue depth of 50 may be normal for a high-throughput
service. For a low-volume internal tool, even 5 tasks sitting for 5 minutes warrants a look.
The signal logic is the same; only the numbers change.

---

## Production Checklist

Before shipping any outbox to production:

```
☐ Indexes are efficient — partial indexes on PENDING/FAILED and PROCESSING states
☐ EXPLAIN ANALYZE confirms index usage on the fetch query
☐ Ordering is not a problem — ORDER BY seq or created_at, backed by index
☐ Processed data cleanup job running, COMPLETED rows removed after retention period
☐ Idempotency handled inside handlers with side effects
☐ Exponential backoff wired — or confirmed not needed for this use case
☐ Metrics in place — queue depth, throughput, error rate, latency
☐ Alerts configured — backlog, error rate, latency, stuck tasks
```

---

## The Ecosystem — You Don't Always Have to Build This

Everything described in this article is something you can build yourself — and there is real
value in doing so at least once. You understand the failure modes, the index choices, the
ordering traps, because you designed around them. That knowledge doesn't go away when you switch
to a library.

But in production, you often don't need to maintain this yourself.

---

**[db-scheduler](https://github.com/kagkarlsson/db-scheduler)** — Gustav Karlsson's
persistent cluster-friendly scheduler for Java. This is the library I keep coming back to and
the one whose internals most closely match what we built in this article. It uses a single
database table, pessimistic locking with `SKIP LOCKED`, heartbeats to detect stuck tasks, and
a clean task/handler interface. When I design self-rolled outboxes, I use db-scheduler as the
reference implementation — the interfaces, the patterns, the failure handling are all sound. If
you're starting a new project and want a battle-tested foundation rather than rolling your own,
start here. The abstractions are thin enough that you'll recognize everything from this article
in the source code.

---

**[Celery](https://docs.celeryq.dev/)** — the de-facto standard for async task execution in
the Python ecosystem. Celery supports PostgreSQL as a result backend and Redis or RabbitMQ as a
broker. The `AFTER_COMMIT` pattern from Part 2.5 applies here too — push to Celery only after
the transaction commits, not inside it.

---

**[Quartz Scheduler](https://www.quartz-scheduler.org/)** — the long-standing Java scheduling
library with JDBC-backed job persistence. More general than an outbox, with cron expressions,
triggers, and job stores. The operational overhead is higher than db-scheduler and the API is
verbose by modern standards, but it's proven at scale with first-class Spring integration via
`spring-boot-starter-quartz`.

---

## Final Thoughts

Most of what's in this article isn't clever engineering — it's accumulated scar tissue. The
`PROCESSING` state exists because someone's app crashed. The heartbeat exists because
`updated_at` lied. The partial index exists because a full table scan at polling frequency
compounds quietly until it doesn't. The `AFTER_COMMIT` listener exists because someone published
an event inside a transaction and spent hours debugging why it never fired.

Each piece is boring on its own. Together they make the difference between an outbox that works
in development and one you can trust at 3am.

---

## Code

Code from this article is available at **[github.com/javaAndScriptDeveloper/outboxes-article](https://github.com/javaAndScriptDeveloper/outboxes-article)**. Everything runs locally with a single command.

---

## Let's Talk

If you hit something I missed, or you've solved one of these problems differently in your own
systems — I'd genuinely like to hear it. Contact links are in the footer.
