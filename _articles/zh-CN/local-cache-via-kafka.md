---
layout: post
lang: zh-CN
lang_key: local-cache-via-kafka
permalink: /zh-CN/2026/08/08/local-cache-via-kafka/
title: "Kafka 能取代 Redis 做缓存同步吗？一份来自生产环境的答案"
date: 2026-08-08
tags: [kafka, spring-boot, java, distributed-systems]
excerpt: "Reddit 上有人问：Kafka 能否取代 Redis，向 25 个 Spring Boot pod 广播缓存更新。这里是一个我在生产环境里见过长期稳定运行的模式——压缩 topic、每个 pod 独立的消费者组、外加一道就绪闸门——并附可运行的 docker-compose 示例。"
description: "Kafka 能否取代 Redis 在多个 Spring Boot pod 之间同步本地缓存？一个生产验证过的模式：压缩 topic （compacted topic）广播、每 pod 独立消费者组、tombstone 删除与就绪门控（readiness gate），附可运行代码与运维取舍分析。"
tech_icon: "fas fa-stream"
og_image:
  header:
    font_family: "Noto Sans CJK SC, Noto Sans CJK, DejaVu Sans, Bold"
    color: "#FFFFFF"
  content:
    font_family: "Noto Sans CJK SC, Noto Sans CJK, DejaVu Sans, Regular"
    color: "#A7F3D0"
  metadata:
    fields: ["date", "tags"]
    separator: " • "
    date_format: "%Y-%m-%d"
faq:
  - question: "Kafka 能取代 Redis 在多个 pod 之间做缓存同步吗？"
    answer: "对于「向每个实例**广播**状态」这个具体职责——可以，但它是用不同的工具做一件相关的事，不是即插即用的替换。Redis 给所有 pod 一个共享缓存视图，Kafka 则给每个 pod 一份**自己的**最终一致副本，靠回放压缩 topic 构建。当本地读取延迟很关键、且更新后短暂过期可以接受时，适用这个模式。"
  - question: "有 N 个 pod 时，每个 pod 都会收到每条 Kafka 消息，还是消息会在它们之间分片？"
    answer: "这完全取决于**消费者组**，与 Kafka 本身无关。共享同一个消费者组的 pod 会瓜分分区（负载均衡）——每条消息只投递给其中一个 pod。给每个 pod **独立**的消费者组，每个组都会独立拿到完整 topic，于是每个 pod 都能看到每条消息。这正是本文讲的广播模式。"
  - question: "怎么给每个 pod 配一个独立的 Kafka 消费者组？"
    answer: "把一个人工控制的 prefix 和 Spring 的按实例 `${random.uuid}` 值组合起来：`group-id: ${CONSUMER_GROUP_PREFIX}-${random.uuid}`。每个应用实例得到一个唯一的组，于是每个 pod 都独立消费完整 topic。"
  - question: "Kafka topic 开启压缩后，删除一个 key 怎么处理？"
    answer: "发布一条**墓碑消息（tombstone）**：相同 key、value 为 **null** 的记录。消费者遇到它时把该 key 从缓存逐出，而不是缓存 null。Kafka 最终会移除被取代的旧值和墓碑本身；把 `delete.retention.ms` 调到足够大，让一次完整回放能在这个窗口内完成——Kafka 官方文档将其定义为从 offset 0 重建有效快照的时间上界。"
  - question: "定时任务和流量要不要等 Kafka 消费追上之后再开始？"
    answer: "要。一个还没回放完 topic 就开始对外提供服务或跑定时任务的 pod，是在用空缓存或半截缓存干活。启动回放完成之前保持就绪状态为 `DOWN`。示例在分区被分配时记录各自的末尾 offset，并等所有已处理位置都到达目标后才放开就绪。"
  - question: "持续不断的更新会让新 pod 永远卡在启动阶段吗？"
    answer: "不会。就绪闸门在 Kafka 分配分区时记录一个固定的末尾 offset。快照之后追加的记录不会移动启动目标；pod 会把它们当作正常的最终一致更新来处理。不过当已有的压缩日志很大时，启动仍可能很慢——这也是该模式最适合特性开关、服务配置这类小体量低频 upsert topic 的原因之一。"
---

# Kafka 能取代 Redis 做缓存同步吗？一份来自生产环境的答案

最近我在 r/apachekafka 上看到一个问题，它精准命中了一个常见的缓存同步难题：
**[Kafka 能否取代 Redis 在多个 Spring Boot pod 之间做缓存同步？](https://www.reddit.com/r/apachekafka/comments/1vhv9nn/can_kafka_replace_redis_for_cache_synchronization/)**

<blockquote class="post-question">
  <span class="post-question-label">原问题（大意）</span>
  <p>Spring Boot 跑在 GCP 上，约 25 个 pod，目前用 Redis 做缓存同步。考虑改用 Kafka：
  缓存条目变化时发布一个事件，每个 pod 消费它并更新自己的本地缓存。Kafka 适合这个场景吗？
  25 个 pod 时，是每个 pod 都收到更新，还是 Kafka 只把它交给一个消费者？每个 pod 需要独立的
  消费者组吗？有没有人真的在线上这么跑过——优缺点是什么？</p>
</blockquote>

我有解决这类问题的经验。本文描述的方案——用一个压缩的 Kafka topic 在每个 pod 内物化一份
本地缓存——是常见模式，已在生产系统里运行多年。它不是 Redis 的万能替代品，但当它的
一致性与运维取舍契合你的负载时，是一个务实的选择。本文会讲清这个模式、实践中真正要紧的
细节，以及一个小的可运行示例。

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-flow.svg' | relative_url }}"
       alt="一个配置生产者向压缩的 Kafka topic 发布消息，三个消费者组分别把它回放进 Pod A、Pod B、Pod C 各自的本地缓存">
  <figcaption>每个 pod 使用独立的消费者组，收到完整的 topic，并用各自的本地缓存对外提供读取。</figcaption>
</figure>

## 问题：快读路径上的共享配置

假设应用里有一类每个实例都会频繁读取的配置或参考数据：功能规则、路由设置、租户设置或
类似数据。它要求读取够快，同时又要能在不重新部署每个 pod 的前提下变更。

共享的 Redis 缓存是自然解。每个 pod 读取同一个集中管理的值，更新之后只有一个当前视图
可查。代价是每次读取都要跨进程，并且依赖缓存服务的可用性与响应速度。取决于所选的缓存
策略，Redis miss 还可能引发一次额外的回源：以 cache-aside 为例，应用先读数据源，再把结果
填回 Redis，下一个请求才能用上缓存。

Kafka 走的是另一条路。更新被追加到一个压缩 topic，每个实例把该 topic 回放进自己的内存缓存。
此后读取就是本地 map 查找。副本之间是最终一致的：pod 开始处理请求时，可能还拿着旧值，
正在追赶进度——如果消费失败，甚至可能没有值。后文会展示如何阻止 pod 在消费完配置之前
做真正的工作。作为交换，Kafka 提供了可用于回放和恢复的持久日志，把读取路径留在 pod 内部，
还能支持 Avro、Protobuf、JSON Schema 这类显式的 schema 序列化。

Kafka 和 Redis 都不是免疫故障的。但如果 Kafka 本来就是已有依赖，用它分发这些配置可以避免
把 Redis 变成又一个运行时依赖、又一个要运维的系统。这减少了需要考虑的活动部件和故障
模式；它不会让 Kafka 的故障消失。只有当最终一致性对这份数据可接受时，这笔交换才是值得的。

Kafka 还能把发布配置的服务与消费配置的服务解耦。双方只需要就记录契约及其 schema 达成
一致；消费者不需要对生产者有直接的运行时依赖。用 Redis 的话，两侧通常得就 key 格式和
序列化后的值达成一致——往往是同一个 DTO 或共享表示——而且消费者必须知道去哪里读。

| 维度 | Redis（共享缓存） | Kafka（压缩 topic → 本地缓存） |
|---|---|---|
| 数据视图 | 一个集中管理的缓存 | 每个实例一份物化缓存 |
| 一致性 | 一个共享缓存视图；源变更仍需正确的失效处理 | 本地副本之间最终一致 |
| 读取路径 | 网络往返；miss 可能需要回源查询 | 初始回放之后是进程内 map 查找 |
| 恢复 / 新实例 | 填充或预热缓存 | 回放压缩 topic |
| 记录历史 | 缓存本身不提供 | 可回放的当前状态；压缩会移除被取代的旧值，因此不是审计日志 |
| 服务耦合 | 共享的 key/value 格式与 Redis 访问 | 共享记录 schema；对生产者无直接依赖 |
| 运维成本 | 共享缓存层，若同时需要 Kafka 则再加一份 | Kafka 存储、消费者，外加每个实例一份缓存 |

本文聚焦如何安全地构建 Kafka 这一侧：把每次更新广播给每个实例、启动时重建缓存，并在
重建完成之前拒绝做任何真实工作。

**关于代码的说明**：这个仓库是一个可运行的演示，不是开箱即用的生产库。我端到端验证过它的
Docker 流程：启动回放、就绪、实时更新和墓碑逐出。在采用该模式之前，请针对你自己的数据量、
rebalance、序列化、重试和宕机场景做测试。

<div class="post-tldr" markdown="1">
<p class="post-tldr-title">TL;DR</p>

- **可以，但有个前提**：Kafka 取代 Redis 的场景是向每个 pod *广播*状态，而不是让大家读同一个共享缓存。每个 pod 得到的是自己最终一致的本地副本。
- **每个 pod 都需要自己的 Kafka 消费者组。**共享一个组的 pod 会瓜分分区（负载均衡）；各自独立组的 pod 各自拿到完整 topic （广播）。
- topic 必须是**压缩的（compacted）**。启动回放需要并发时使用多个分区；开启监听器并发后，本地缓存必须**线程安全**。
- 数据集要保持**小而相对低频**。这个模式适合特性开关、路由规则和服务配置——不适合大体量、高变更率的业务数据集。
- **删除就是墓碑**：一条 value 为 null 的记录，而不是什么特殊的「删除」消息类型。
- **启动回放完成之前，不要与外部世界交互。**不要在残缺的本地缓存上对外提供端点、跑定时任务、处理队列消息或做其他外部可见的工作。回放完成后才打开就绪。
- 独立的消费者组会留下不活跃的 offset 元数据，直到 Kafka 按配置的保留策略清掉它。消费者组工具里会出现临时杂物，请监控相关的 broker 配置。
</div>

---

## 整体流程如何运转

分两个阶段：**重建本地副本**，然后**让它保持更新**。

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-lifecycle.svg' | relative_url }}"
       alt="Kafka 本地缓存的两阶段生命周期：启动阶段记录固定的分区目标并保持就绪为 DOWN，同时应用记录；稳态打开就绪、用本地缓存服务读取，并继续应用后续更新">
  <figcaption>启动有一条固定的终点线。每个分区都到达终点后，同一个监听器会继续维护已就绪 pod 的本地缓存。</figcaption>
</figure>

1. 生产者向压缩 topic 写入一条 upsert。Kafka 记录的 key 是配置键，value 是最新配置。value 为 null 表示删除的墓碑。
2. 新 pod 以新的消费者组和 `auto.offset.reset=earliest` 启动，于是 Kafka 把 topic 的每个分区都分配给该 pod 的组，回放从最旧的保留 offset 开始。
3. 分配分区时，就绪闸门为每个分区读取两个数字：消费者当前的位置和分区的末尾 offset。这个末尾 offset 成为**固定的启动目标**。
4. 监听器把每条记录应用到线程安全的本地 map。只有监听器成功返回之后，跟踪切面才推进该分区的已处理位置。因此监听器失败不可能让闸门误以为失败的记录已被应用。
5. 当每个分区都到达记录的目标，就绪状态变为 `UP`。部署平台此刻起可以把请求路由到该 pod，受就绪门控的定时任务也可以运行。读取走本地 map，不访问 Kafka。
6. 启动之后同一个消费者继续工作。新记录到达时更新或删除本地条目，各 pod 独立收敛，彼此最终一致。

第 3 步中的固定目标很关键。如果回放进行中生产者又写入了一条记录，这条新记录不会让启动
终点线无限后移。消费者仍会通过正常的监听器路径处理它，但就绪是针对分配时捕获的快照
定义的。真正可能拖慢启动的是一个庞大的已有日志，而不是后续低频的更新流。这就是为什么
该模式面向特性开关、路由规则、服务配置这类小体量低变更的 upsert 数据集。

---

## 用压缩 topic 发布当前状态

先以 `cleanup.policy=compact` 创建配置 topic。压缩会为每个 key 保留最新的记录，因此晚启动的
pod 可以从头回放 topic、重建当前配置，而不必请另一个服务帮它预热缓存。

这种方式最适合小而相对低频的 upsert topic：特性开关、路由规则、租户设置或类似配置。对每个
pod 都要回放并驻留内存的大体量、高变更数据集来说，它不是好的默认选择。

如果启动时间重要，就创建足够多的分区，让一个 pod 能用多个消费者线程并发回放 topic。有效
并发上限就是分区数；监听器并发配置大于 1 时，本地缓存必须线程安全。示例里由一个一次性的
`kafka-topic-init` 服务在应用启动之前创建并播种（seed） topic。

下一个需求是确保每个 pod 都能收到这份数据。

## 给每个 Pod 独立的消费者组

一个 Kafka 消费者组对 topic 有一个独立视图：组内每个分区只分配给一个消费者。因此共享组的
pod 瓜分工作；分开组的 pod 各自消费完整 topic。

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-consumer-groups.svg' | relative_url }}"
       alt="共享 Kafka 消费者组（分区在 pod 之间瓜分）与每 pod 一个独立组（每个 pod 收到全部分区）的对比">
  <figcaption>共享组瓜分状态。每个 pod 一个独立组，让每份本地缓存都拿到完整状态。</figcaption>
</figure>

给每个 pod 一个唯一的 `group.id`。示例中用共享前缀标识这次部署，用 Spring 的
`${random.uuid}` 提供按实例的后缀：

```yaml
app:
  config-topic: ${CONFIG_TOPIC:local-cache-config}
  kafka:
    bootstrap-servers: ${KAFKA_BOOTSTRAP_SERVERS:localhost:9092}
    consumer-group: ${CONSUMER_GROUP_PREFIX:local-cache-demo}-${random.uuid}
```

每次启动都会创建一个新组，必须重建本地缓存。因此要在消费者属性里把 `auto.offset.reset`
设为 `earliest`。`latest` 会让新 pod 一直空着，直到下一次更新到来。

```java
Map<String, Object> consumerProperties = Map.of(
        // other consumer properties...
        ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
```

topic 与广播行为就位后，每个 pod 都能物化出相同的本地状态。

## 在本地缓存中物化更新

topic 里有了当前状态、每个 pod 也都能收到之后，监听器刻意保持极简：普通记录放进本地缓存，
墓碑则移除对应 key。

```java
@Slf4j
@Component
@RequiredArgsConstructor
public class ConfigTopicListener {

    private final LocalConfigCache cache;

    @ConfigConsumer("config-topic")
    @KafkaListener(topics = "${app.config-topic}")
    public void onMessage(ConsumerRecord<String, String> record) {
        if (record.value() == null) {
            log.debug("Tombstone for key '{}' — evicting from local cache", record.key());
            cache.remove(record.key());
            return;
        }
        cache.put(record.key(), record.value());
    }
}
```

普通记录覆盖创建和更新。删除还需要一条额外约定。

## 用墓碑删除配置

同 key 且 **value 为 null** 的记录就是**墓碑（tombstone）**。压缩会把它保留足够久，让消费者
观察到这次删除，之后最终移除它。`delete.retention.ms` 同时也是一个上界：消费者从 offset 0
开始扫描，必须在这个窗口内完成，才能保证拿到有效的最终状态快照，
[Kafka broker 配置参考](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_log.cleaner.delete.retention.ms)
对此有说明。这个窗口请按实测的最坏回放耗时来配置；不要想当然地认为默认值对大 topic 就是
安全的。

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-tombstone-flow.svg' | relative_url }}"
       alt="配置管理员发布一条 value 为 null 的 Kafka 墓碑，每个 pod 消费它并从本地缓存移除对应的 key">
  <figcaption>墓碑和其他记录一样广播；每个 pod 把它的 null value 理解为移除该 key 的指令。</figcaption>
</figure>

只有当应用确实应该彻底遗忘这份配置时，硬删除才合适。如果一份停用的配置还要为审计、历史
数据或将来重新启用而保留，就发布一条 `active: false` 或 `deactivatedAt` 的普通记录，让它继续
留在缓存里。如果条目总数不大，把所有配置都留在本地反而更简单。压缩 topic 只保留每个 key 的
最新值，不是无限保留每个历史版本；需要完整历史时，用带版本的 key 或单独的 history topic。

示例的 `LocalConfigCache` 用的是 `ConcurrentHashMap`。Spring Kafka 默认以一个消费者线程
启动，但配置的监听器并发可能从多个线程更新同一个缓存。监听器上的 `@ConfigConsumer` 注解
把它与下一节介绍的就绪闸门关联起来。

到这里，每个 pod 都能构建出正确的本地状态。但在回放结束之前，它仍然不能使用这份状态。

## 追平之前，不要对外提供服务

> 在配置被消费完之前，不要接流量、不要跑定时任务、不要做任何其他外部可见的工作。

这是最容易跳过、跳过代价又最高的一步。一个刚被分配分区就上报「就绪」的 pod，只是在名义上
就绪——它可能三千条记录只回放了三条。请求打在几乎为空的缓存上；定时任务按过期的默认值
运行；没人注意到，直到有人问为什么部署之后 14 号 pod 的行为异常了整整两分钟。

示例把这件事封装成一个小的 `readiness-gate` 模块。Kafka 分配分区时，闸门记录它们的当前
末尾 offset 作为启动目标。每条成功处理的记录推进其分区已跟踪的位置。只有每个分区都到达
记录的目标、且没有遗留的处理错误之后，就绪才打开。空 topic 也没问题：它们的起始位置本来就
等于末尾 offset。

目标是固定的快照。分区分配之后发布的记录不会延长它，因此持续更新的 topic 不可能让 pod
永远卡在启动阶段。一旦到达记录的目标，后续记录继续走正常的实时更新路径，并仍然受下文
所述最终一致取舍的约束。

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-readiness-gate.svg' | relative_url }}"
       alt="就绪闸门的四个阶段：注册配置消费者，记录固定的分区目标，回放记录且仅在成功后推进位置，全部目标达成后打开就绪">
  <figcaption>闸门初始关闭，对照固定目标跟踪成功回放，只有每个被分配分区都追平后才打开。</figcaption>
</figure>

整个流程有四个职责。第一，用一个标记注解标识 `@KafkaListener` 方法，就绪闸门会跟踪它的
`ConsumerRecord` 参数：

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface ConfigConsumer {
    String value() default "";
}
```

第二，跟踪器记录分配时捕获的目标末尾 offset，以及每条成功处理记录之后的下一个 offset：

```java
@Component
public class ConsumptionTracker {

    private final ConcurrentMap<String, ConsumerReplayProgress> progressByConsumerId =
            new ConcurrentHashMap<>();

    public void register(String consumerId) {
        progressByConsumerId.computeIfAbsent(consumerId, ignored -> new ConsumerReplayProgress());
    }

    public void onPartitionsAssigned(
            String consumerId,
            Map<TopicPartition, Long> currentPositions,
            Map<TopicPartition, Long> targetEndOffsets) {
        progressFor(consumerId).assign(currentPositions, targetEndOffsets);
    }

    public void onRecordProcessed(String consumerId, ConsumerRecord<?, ?> record) {
        progressFor(consumerId).recordSuccess(
                new TopicPartition(record.topic(), record.partition()),
                positionAfter(record));
    }

    public boolean isFullyConsumed() {
        return progressByConsumerId.isEmpty()
                || progressByConsumerId.values().stream()
                        .allMatch(ConsumerReplayProgress::isCaughtUp);
    }

    // Kafka positions identify the next record to read, not the last one already processed.
    private long positionAfter(ConsumerRecord<?, ?> record) {
        return Math.incrementExact(record.offset());
    }
}
```

`ConsumerReplayProgress` 持有被分配的分区，而小型的 `PartitionReplayProgress` 持有单个分区的
当前位置、固定目标和错误。把这些职责分开，让就绪规则变得显式：每个被分配的分区都必须
到达自己的目标，而一个失败只能由来自同一分区的成功记录清除。

一个 `@Around` 切面自动把每条成功处理的 `ConsumerRecord` 上报给跟踪器——监听器方法本身
从不直接调用它，这也是上面的 `ConfigTopicListener.onMessage` 里完全没有就绪相关代码、只有
`@ConfigConsumer("config-topic")` 注解的原因。一个独立的注册器在启动时、第一条消息到达之前
预注册每个 `@ConfigConsumer` 方法。`ConsumerAwareRebalanceListener` 提供分区分配及其捕获的
末尾 offset。这让就绪状态从启动起保持 `DOWN`，直到监听器处理完所有目标，并在 rebalance
之后重新计算目标。

第三，通过一个普通的 `HealthIndicator` 把闸门暴露在 Spring Boot 的 **readiness** 健康组里。
它把缓存状态与 Boot 自己的 readiness 状态组合起来，给部署平台一个稳定的轮询端点。它也避免
了在启动期间与 Boot 的应用可用性事件互相干扰：

```java
@Component("configConsumption")
@RequiredArgsConstructor
public class ConfigConsumptionHealthIndicator implements HealthIndicator {

    private final ConsumptionTracker tracker;

    @Override
    public Health health() {
        var details = tracker.describe();
        return tracker.isFullyConsumed()
                ? Health.up().withDetails(details).build()
                : Health.down().withDetails(details).build();
    }
}
```

```yaml
management:
  endpoint:
    health:
      "group[readiness]":
        include: readinessState,configConsumption
```

`/actuator/health/readiness` 现在只有在每个被分配分区都到达记录的启动目标之后才会报告
`UP`。配置部署平台在该端点返回成功之前不放入流量。

示例的 Docker Compose 服务用同一个端点作为它的 `healthcheck`，因此 Docker 只在回放完成
之后才把应用标记为健康。这对应部署平台的可用性检查；Compose 的健康状态本身并不控制
流量路由。

第四，用同样的方式门控定时任务（或任何其他 bean 方法），而不用在每个调用点重复
`if (!tracker.isFullyConsumed()) return;` 检查：再加一个注解 `@ReadinessGated`，配上一个专属
的小切面，在闸门打开之前直接跳过调用——上面的 `CacheSnapshotJob.logSnapshot` 实际标注的
就是它：

```java
@Aspect
@Component
@RequiredArgsConstructor
public class ReadinessGateAspect {

    private final ConsumptionTracker tracker;

    @Around("@annotation(com.example.company.readinessgate.ReadinessGated)")
    public Object skipUntilReady(ProceedingJoinPoint joinPoint) throws Throwable {
        if (!tracker.isFullyConsumed()) {
            log.debug("Skipping {} — readiness gate not open yet", joinPoint.getSignature().toShortString());
            return null;
        }
        return joinPoint.proceed();
    }
}
```

形状和前面的 `@ConfigConsumer` 切面一样，方向相反：那个向跟踪器*上报*活动，这个*读取*它并
决定是否放行调用。它只对 `void` 方法有意义——被跳过的调用返回 `null`——而这恰恰就是
`@Scheduled` 任务的形态。

### 就绪闸门的落地

应用必须阻塞所有依赖这份配置的对外交互；否则它可能基于空缓存或过期缓存采取行动。示例
实现了两道这样的闸门，但同一原则适用得更广。

对 HTTP 流量，`ConfigConsumptionHealthIndicator` 在回放完成之前让 readiness 端点保持
`DOWN`。当部署平台用该端点扣住流量时，controller 不必在每个端点里重复
`tracker.isFullyConsumed()`。例如在 Kubernetes 里，用 `readinessProbe` 控制路由，并给
`startupProbe` 足够的时间完成一次大规模初始回放：

```java
@GetMapping("/api/cache")
public ResponseEntity<Map<String, CacheEntry>> all() {
    return ResponseEntity.ok(cache.snapshot());
}
```

对定时任务，`@ReadinessGated` 在同一个跟踪器就绪之前阻止调用：

```java
@ReadinessGated
@Scheduled(fixedDelayString = "${app.cache-snapshot-job.interval}")
public void logSnapshot() {
    log.info("Local cache holds {} entries", cache.size());
}
```

其他对外交互也需要等价的闸门。例如，依赖这份配置的队列监听器不应该在缓存就绪之前开始
处理；可以在监听器/容器层面安排，或采用一种在闸门关闭期间既不确认也不丢消息的确认策略。
本示例只为 HTTP 流量和定时任务提供了闸门，但同一个就绪信号可以为队列消费者、对外调用或
任何其他依赖配置的工作驱动等价的保护。

## 这个模式的代价在哪里

正常路径很诱人：回放一次，然后享用本地读取。运维成本出现在边界上——启动、lag、保留策略
和故障。以下就是我在选择该模式之前会想清楚的几个决定。

### 每次重启都要付回放成本

新组没有 offset，所以每个 pod 都从头重建。因此成本随压缩日志中仍存在的记录数增长——而不
是简单地随当前 key 数增长，因为压缩是异步的，旧 segment 可能还要留存一段时间。用接近生产
规模的数据实测回放耗时，并给 `startupProbe` 足够的预算。Kafka 本来就批量拉取记录，调好
`max.poll.records` 并保持单条记录的处理足够便宜。更大的回放可以把监听器切到批量模式，一次
调用里应用返回的整批列表；示例的跟踪切面同时支持单个 `ConsumerRecord` 参数和可迭代的
批次。只有当 topic 分区足够多时才加监听器并发。三个分区最多允许一个 pod 里的三个消费者线程
并行推进。最坏情况的回放还必须落在 topic 的墓碑保留窗口之内，否则从 offset 0 开始的扫描不
保证能重建有效快照。

回放期间生产者追加新记录不会移动已捕获的目标，因此持续写入不会让启动时间无界。决定启动
时间的是已有日志。如果这份日志大到让就绪变得缓慢或不可预测，这个 topic 多半已经超出该模式
面向的低频配置场景了。

### 独立消费者组会留下临时元数据

每个 pod 都生成一个新的消费者组。pod 消失之后，它提交的 offset 仍然可见，直到 Kafka 按
broker 的保留设置移除不活跃组的元数据。这通常是运维杂物，不是持续增长的实时负载，但它会
影响监控大盘，以及任何「假定列出的组都活跃」的自动化。用一个可识别的前缀，监控 broker 的
[offset 保留策略](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_offsets.retention.minutes)，
并在工具里过滤不活跃的组。

### 大配置不该塞进每个 Pod

这个模式适合小而高频读取的配置集合。如果配置很大，把整个数据集放进本地内存通常是坏
主意。每个 pod 都要为它自己的那份副本准备足够的堆，加 pod 就是在线性放大这笔内存开销。
把大配置放进共享存储，或者只物化每个服务真正需要的那一小块。

### 最终一致是契约的一部分

每个 pod 独立消费更新，两个 pod 可能短暂返回不同的值。慢消费者、rebalance、重试或 Kafka
宕机都会拉长这个窗口。对特性开关、路由提示和其他容忍短暂过期的配置来说可以接受；对鉴权
判断、库存、余额，或任何必须「同一瞬间在所有地方生效」的规则来说则是糟糕的选择。选定这个
设计之前，先定义可容忍的滞后、监控它，并把过期数据的行为明确告知调用方。

这些成本并不说明模式错了。它们划定的是它的适用范围：紧凑、可回放、最终一致的参考数据，
读取路径非常热，且团队本来就能熟练运维 Kafka。

<aside class="post-lab-cta">
  <span class="post-lab-cta-label">交互式生产实验室</span>
  <h2>你能守住这套架构吗？</h2>
  <p>诊断四个故障：消费者组、启动回放、就绪与墓碑。大约需要五分钟。</p>
  <a href="{{ '/labs/kafka-local-cache/' | relative_url }}" class="btn-primary">
    进入事故实验室 <i class="fas fa-arrow-right"></i>
  </a>
</aside>

## 示例代码

本文代码见
**[github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article](https://github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article)**。
仓库 README 里有搭建和运行说明，包括如何查看消费者组、观察墓碑传播以及在本地扩容应用。

---

## 欢迎交流

如果你正在——或者曾经——线上运行类似的东西，我想知道这些取舍在你那里落在了哪边。
联系方式见页脚。
