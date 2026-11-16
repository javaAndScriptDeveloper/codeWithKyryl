---
layout: post
lang: de
lang_key: local-cache-via-kafka
permalink: /de/2026/08/08/local-cache-via-kafka/
title: "Kann Kafka Redis für die Cache-Synchronisation ersetzen? Eine Antwort aus der Produktion"
date: 2026-08-08
tags: [kafka, spring-boot, java, distributed-systems]
excerpt: "Ein Reddit-Thread fragte, ob Kafka Redis ersetzen kann, um Cache-Updates an 25 Spring-Boot-Pods zu broadcasten. Dieses Pattern läuft bei mir seit Jahren in Produktion: ein kompaktierter Topic, eine Consumer Group pro Pod und ein Readiness Gate, mit lauffähigem Docker-Compose-Beispiel."
description: "Kann Kafka Redis für Cache-Sync über Spring-Boot-Pods ersetzen? Praxiserprobtes Pattern: kompaktierter Topic, Consumer Group pro Pod, Readiness Gate – mit Code."
tech_icon: "fas fa-stream"
faq:
  - question: "Kann Kafka Redis für die Cache-Synchronisation über Pods hinweg ersetzen?"
    answer: "Ja, aber nur für die konkrete Aufgabe, State an jede Instanz zu **broadcasten**. Es ist ein anderes Werkzeug für eine verwandte Aufgabe, kein Drop-in-Ersatz. Redis gibt jedem Pod eine gemeinsame Cache-Sicht, während Kafka jedem Pod seine **eigene**, eventually konsistente Kopie gibt, die durch das Replay eines kompaktierten Topics entsteht. Nutze dieses Pattern, wenn die Latenz lokaler Reads zählt und es akzeptabel ist, dass Daten nach einem Update kurzzeitig veraltet sind."
  - question: "Bekommt bei N Pods jeder Pod jede Kafka-Nachricht, oder verteilt Kafka die Nachrichten auf die Pods?"
    answer: "Das hängt ausschließlich von der **Consumer Group** ab, nicht von Kafka selbst. Pods, die sich eine Consumer Group teilen, bekommen die Partitionen untereinander aufgeteilt (Lastverteilung), und jede Nachricht geht an genau einen Pod. Gib jedem Pod seine **eigene** Consumer Group, und jede Group erhält den vollständigen Topic unabhängig von den anderen, sodass jeder Pod jede Nachricht sieht. Das ist das Broadcast-Pattern, das dieser Artikel behandelt."
  - question: "Wie gebe ich jedem Pod seine eigene Kafka Consumer Group?"
    answer: "Kombiniere ein selbst festgelegtes Präfix mit dem von Spring pro Instanz erzeugten `${random.uuid}`: `group-id: ${CONSUMER_GROUP_PREFIX}-${random.uuid}`. Jede Anwendungsinstanz bekommt eine eigene Group, sodass jeder Pod den vollständigen Topic unabhängig konsumiert."
  - question: "Wie löscht man einen Key, wenn das Kafka-Topic kompaktiert ist?"
    answer: "Publiziere einen **Tombstone**: einen Record mit demselben Key und einem **null**-Wert. Consumer, die ihn lesen, entfernen den Key aus dem Cache, statt null zu cachen. Kafka löscht irgendwann sowohl den überholten Wert als auch den Tombstone; dimensioniere `delete.retention.ms` so, dass ein vollständiges Replay in diesem Fenster abschließen kann. Laut Kafka-Dokumentation ist das die Grenze, innerhalb der ein Consumer, der bei Offset null beginnt, garantiert einen gültigen Snapshot des Endzustands erhält."
  - question: "Sollten Scheduled Jobs und Traffic warten, bis der Kafka-Consumer aufgeholt hat?"
    answer: "Ja. Ein Pod, der Requests bedient oder Scheduled Jobs ausführt, bevor er den Topic replayt hat, arbeitet aus einem leeren oder teilweisen Cache. Halte die Readiness auf `DOWN`, bis das Startup-Replay abgeschlossen ist. Das Beispiel erfasst bei der Zuweisung jeder Partition ihren End-Offset und öffnet die Readiness erst, wenn die verarbeitete Position jeder Partition ihr Ziel erreicht hat."
  - question: "Können laufende Updates einen neuen Pod dauerhaft im Startup festhalten?"
    answer: "Nein. Das Readiness Gate erfasst bei der Zuweisung jeder Partition einen festen End-Offset. Records, die nach diesem Snapshot angehängt werden, verschieben das Startup-Ziel nicht; der Pod verarbeitet sie als normale, eventually konsistente Updates. Das Startup kann trotzdem lange dauern, wenn der bestehende kompaktierte Log groß ist. Das ist einer der Gründe, warum dieses Pattern am besten zu kleinen Upsert-Topics mit wenigen Änderungen passt, etwa Feature-Flags und Service-Konfiguration."
---

# Kann Kafka Redis für die Cache-Synchronisation ersetzen? Eine Antwort aus der Produktion

Kürzlich bin ich in r/apachekafka auf eine Frage gestoßen, die ein verbreitetes
Problem bei der Cache-Synchronisation auf den Punkt bringt:
**[Kann Kafka Redis für die Cache-Synchronisation über mehrere Spring-Boot-Pods hinweg ersetzen?](https://www.reddit.com/r/apachekafka/comments/1vhv9nn/can_kafka_replace_redis_for_cache_synchronization/)**

<blockquote class="post-question">
  <span class="post-question-label">Die Originalfrage, sinngemäß wiedergegeben</span>
  <p>Spring Boot auf GCP, rund 25 Pods, die Cache-Synchronisation läuft derzeit über Redis. Kafka
  ist als Alternative im Gespräch: Ein Event publizieren, wenn sich ein Cache-Eintrag ändert, jeder
  Pod konsumiert es und aktualisiert seinen eigenen lokalen Cache. Passt Kafka hier? Bekommen bei
  25 Pods alle Pods das Update, oder gibt Kafka es an nur einen Consumer? Braucht jeder Pod seine
  eigene Consumer Group? Hat das schon jemand im Betrieb? Was spricht dafür, was dagegen?</p>
</blockquote>

Ich habe Erfahrung mit dieser Art von Problem. Der hier beschriebene Ansatz, ein
kompaktiertes Kafka-Topic, das in jedem Pod einen lokalen Cache materialisiert, ist ein
verbreitetes Pattern und läuft seit Jahren in Produktionssystemen. Es ist kein universeller
Ersatz für Redis, aber eine praktische Option, wenn seine Konsistenz- und Betriebs-Trade-offs zur
Workload passen. Dieser Artikel erklärt das Pattern, die Details, auf die es in der Praxis ankommt, und
zeigt ein kleines lauffähiges Beispiel.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-flow.svg' | relative_url }}"
       alt="Ein Konfigurations-Producer publiziert in einen kompaktierten Kafka-Topic, den drei Consumer Groups in jeweils eigene lokale Caches in Pod A, Pod B und Pod C replayen">
  <figcaption>Jeder Pod hat eine eigene Consumer Group, erhält den vollständigen Topic und bedient Reads aus seinem eigenen lokalen Cache.</figcaption>
</figure>

## Das Problem: Geteilte Konfiguration auf einem heißen Read-Pfad

Angenommen, die Anwendung hat Konfigurations- oder Referenzdaten, die jede Instanz häufig braucht:
Feature-Regeln, Routing-Einstellungen, Tenant-Einstellungen oder Ähnliches. Sie müssen sich
schnell abrufen lassen, aber sie müssen sich auch ändern lassen, ohne jeden Pod neu auszurollen.

Ein gemeinsamer Redis-Cache ist eine naheliegende Lösung. Jeder Pod liest denselben zentral
verwalteten Wert, nach einem Update gibt es also genau eine aktuelle Sicht. Der Trade-off: Jeder
Lesezugriff verlässt den Prozess und hängt davon ab, dass der Cache-Service verfügbar ist und schnell
antwortet. Je nach gewählter Cache-Strategie kann ein Redis-Miss auch einen zusätzlichen Lookup
auslösen: Bei Cache-Aside etwa liest die Anwendung die Source of Truth und befüllt Redis, bevor
der nächste Request den Cache nutzen kann.

Kafka geht einen anderen Weg. Ein Update wird an einen kompaktierten Topic angehängt, und jede
Instanz replayt diesen Topic in ihren eigenen In-Memory-Cache. Reads werden dann zu lokalen
Map-Lookups. Die Replikate sind eventually konsistent: Wenn ein Pod mit der Arbeit beginnt,
kann er beim Aufholen noch einen älteren Wert haben – oder gar keinen, wenn der Konsum
fehlgeschlagen ist. Später zeige ich, wie man verhindert, dass ein Pod echte Arbeit erledigt,
bevor er die Konfiguration konsumiert hat. Im Gegenzug bietet Kafka einen dauerhaften Log für Replay
und Recovery, hält den Read-Pfad im Pod und unterstützt explizite, schemabasierte Serialisierung wie
Avro, Protobuf oder JSON Schema.

Weder Kafka noch Redis sind immun gegen Ausfälle. Ist Kafka aber bereits eine Dependency, kann
es sich lohnen, die Konfiguration darüber zu verteilen, statt Redis als weitere Laufzeit-Abhängigkeit
und als weiteres System im Betrieb hinzuzunehmen. Das reduziert die Zahl der beweglichen Teile
und der zu betrachtenden Ausfallszenarien; Kafka-Ausfälle verschwinden dadurch nicht. Ein guter
Tausch ist das nur, wenn Eventual Consistency für die Daten akzeptabel ist.

Kafka kann zudem den Service, der Konfiguration publiziert, von den Services entkoppeln, die sie
konsumieren. Sie müssen sich nur auf den Record-Contract und sein Schema einigen; Consumer
brauchen keine direkte Laufzeit-Abhängigkeit vom Producer. Bei Redis müssen beide Seiten
typischerweise Key-Format und serialisierten Wert abstimmen (oft dasselbe DTO oder
eine gemeinsame Repräsentation), und Consumer müssen wissen, wo sie ihn lesen.

| Aspekt | Redis (geteilter Cache) | Kafka (kompaktierter Topic → lokaler Cache) |
|---|---|---|
| Datensicht | Ein zentral verwalteter Cache | Ein materialisierter Cache pro Instanz |
| Konsistenz | Eine gemeinsame Cache-Sicht; Änderungen an der Quelle erfordern weiterhin korrektes Invalidieren | Eventual Consistency zwischen lokalen Replikaten |
| Read-Pfad | Netzwerk-Roundtrip; Misses können einen Lookup an der Source of Truth erfordern | In-Process-Map-Lookup nach dem initialen Replay |
| Recovery / neue Instanzen | Cache befüllen oder vorwärmen | Den kompaktierten Topic replayen |
| Record-Historie | Nicht inhärenter Teil des Caches | Replayfähiger aktueller State; die Kompaktierung entfernt überholte Werte, es ist also kein Audit-Log |
| Service-Kopplung | Geteiltes Key/Value-Format und Redis-Zugriff | Geteiltes Record-Schema; keine direkte Producer-Dependency |
| Betriebsaufwand | Geteilte Cache-Tier, plus Kafka, falls ebenfalls benötigt | Kafka-Speicher, Consumer und ein Cache pro Instanz |

Dieser Artikel konzentriert sich darauf, die Kafka-Seite sicher zu bauen: jedes Update an
jede Instanz broadcasten, den Cache beim Startup neu aufbauen und echte Arbeit verweigern, bis
dieser Neuaufbau abgeschlossen ist.

**Ein Hinweis zum Code**: Das Repository ist eine lauffähige Demo, keine
Produktionsbibliothek zum Einbinden. Ich habe den Docker-Ablauf Ende-zu-Ende geprüft:
Startup-Replay, Readiness, Live-Updates und Entfernen per Tombstone. Bevor du das Pattern übernimmst,
teste es mit deinen eigenen Szenarien für Datenvolumen, Rebalancing, Serialisierung, Retries und
Ausfälle.

<div class="post-tldr" markdown="1">
<p class="post-tldr-title">TL;DR</p>

- **Ja, mit einer Einschränkung**: Kafka ersetzt Redis für das *Broadcasten* von State an jeden
  Pod, nicht für das Lesen aus einem gemeinsamen Cache. Jeder Pod bekommt seine eigene
  eventually konsistente lokale Kopie.
- **Jeder Pod braucht seine eigene Kafka Consumer Group.** Pods, die sich eine Group teilen,
  teilen sich die Partitionen auf (Lastverteilung); Pods in jeweils eigenen Groups bekommen jeweils
  den vollständigen Topic (Broadcast).
- Der Topic muss **kompaktiert** sein. Nutze mehr als eine Partition, wenn das Startup-Replay
  Concurrency braucht, und mache den lokalen Cache **thread-safe**, wenn Listener-Concurrency
  aktiviert ist.
- Halte den Datensatz **klein und änderungsarm**. Dieses Pattern passt zu Feature-Flags,
  Routing-Regeln und Service-Konfiguration, nicht zu einem großen oder sich stark ändernden
  Fachdatensatz.
- **Löschungen sind Tombstones**: ein Record mit null-Wert, kein spezieller „Delete“-Nachrichtentyp.
- **Warte, bis das Startup-Replay abgeschlossen ist, bevor du mit der Außenwelt interagierst.**
  Bediene keine Endpunkte, führe keine Scheduled Jobs aus, verarbeite keine Queue-Nachrichten und
  erbringe keine andere nach außen sichtbare Arbeit auf Basis eines unvollständigen lokalen Caches. Öffne die
  Readiness erst, nachdem das Replay abgeschlossen ist.
- Eigene Groups hinterlassen inaktive Offset-Metadaten, bis die konfigurierte Retention von Kafka sie
  entfernt. Rechne mit vorübergehendem Ballast im Consumer-Group-Tooling und behalte die relevanten
  Broker-Einstellungen im Blick.
</div>

---

## Wie der gesamte Ablauf funktioniert

Es gibt zwei Phasen: **die lokale Replik neu aufbauen**, dann **sie aktuell halten**.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-lifecycle.svg' | relative_url }}"
       alt="Zweiphasiger Kafka-Local-Cache-Lebenszyklus: Das Startup erfasst feste Partition-Ziele und hält die Readiness unten, während Records angewendet werden; der stationäre Betrieb öffnet die Readiness, bedient lokale Reads und wendet weiterhin spätere Updates an">
  <figcaption>Das Startup hat eine feste Ziellinie. Sobald jede Partition sie erreicht hat, hält derselbe Listener den lokalen Cache des bereiten Pods aktuell.</figcaption>
</figure>

1. Ein Producer schreibt einen Upsert in den kompaktierten Topic. Der Kafka-Record-Key ist der
   Konfigurations-Key; sein Wert ist die aktuelle Konfiguration. Ein null-Wert ist ein Tombstone,
   der Löschen bedeutet.
2. Ein neuer Pod startet mit einer neuen Consumer Group und `auto.offset.reset=earliest`; Kafka
   weist jede Topic-Partition der Group dieses Pods zu, und das Replay beginnt an den ältesten
   vorgehaltenen Offsets.
3. Bei der Zuweisung liest das Readiness Gate für jede Partition zwei Zahlen: die aktuelle
   Position des Consumers und den End-Offset der Partition. Dieser End-Offset wird das **feste
   Startup-Ziel**.
4. Der Listener wendet jeden Record auf eine thread-safe lokale Map an. Erst nachdem der Listener
   erfolgreich zurückkehrt, bringt der Tracking-Aspect die verarbeitete Position dieser Partition
   voran. Ein Listener-Fehler kann dem Gate also nie vortäuschen, der fehlgeschlagene Record sei
   angewendet worden.
5. Wenn jede Partition ihr erfasstes Ziel erreicht, wechselt die Readiness auf `UP`. Die
   Deployment-Plattform darf Requests nun an den Pod routen, und durch Readiness geschützte
   Scheduled Jobs dürfen laufen. Reads nutzen die lokale Map und rufen Kafka nicht auf.
6. Derselbe Consumer bleibt nach dem Startup aktiv. Neue Records aktualisieren oder löschen
   lokale Einträge, sobald sie eintreffen; Pods konvergieren also unabhängig und sind eventually
   konsistent zueinander.

Das feste Ziel aus Schritt 3 ist wichtig. Schreibt ein Producer, während das Replay läuft,
verschiebt der neue Record die Startup-Ziellinie nicht endlos. Der Consumer verarbeitet ihn
weiterhin über den normalen Listener-Pfad, aber die Readiness bemisst sich am Snapshot, der bei
der Zuweisung erfasst wurde. Was das Startup verlangsamen kann, ist ein großer bestehender Log,
nicht ein Strom späterer, seltener Updates. Deshalb ist das Pattern für kleine,
änderungsarme Upsert-Datensätze gedacht, etwa Feature Flags, Routing-Regeln und
Service-Konfiguration.

---

## Den aktuellen State in einen kompaktierten Topic publizieren

Lege zuerst den Konfigurations-Topic mit `cleanup.policy=compact` an. Die Kompaktierung behält
den neuesten Record je Key, sodass ein später startender Pod den Topic von vorn replayen und die
aktuelle Konfiguration rekonstruieren kann, ohne einen anderen Service zu bitten, seinen Cache
vorzuwärmen.

Das funktioniert am besten für ein kleines Upsert-Topic mit seltenen Änderungen:
Feature Flags, Routing-Regeln, Tenant-Einstellungen oder ähnliche Konfiguration. Für einen
großen oder stark wechselnden Datensatz, den jeder Pod replayen und im Speicher halten müsste,
ist es keine gute Standardwahl.

Lege genug Partitionen an, damit ein Pod den Topic bei relevanten Startup-Zeiten mit mehreren
Consumer-Threads parallel replayen kann. Die nützliche Concurrency ist durch die Partitionszahl
begrenzt, und der lokale Cache muss thread-safe sein, wenn Listener-Concurrency über eins
konfiguriert ist. Im Beispiel legt ein One-shot-`kafka-topic-init`-Service den Topic an und
befüllt ihn, bevor die Anwendung startet.

Die nächste Anforderung ist sicherzustellen, dass jeder Pod diesen State erhält.

## Gib jedem Pod seine eigene Consumer Group

Jede Kafka Consumer Group sieht einen Topic unabhängig von den anderen: Innerhalb der Group
wird jede Partition genau einem Consumer zugewiesen. Pods, die sich eine Group teilen, teilen also
die Arbeit untereinander auf; Pods in getrennten Groups konsumieren jeweils den vollständigen Topic.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-consumer-groups.svg' | relative_url }}"
       alt="Vergleich einer geteilten Kafka Consumer Group, bei der Partitionen zwischen Pods aufgeteilt werden, mit einer eigenen Group pro Pod, bei der jeder Pod alle Partitionen erhält">
  <figcaption>Eine geteilte Group teilt den State. Eine eigene Group pro Pod gibt jedem lokalen Cache den vollständigen State.</figcaption>
</figure>

Gib jedem Pod eine eigene `group.id`. In diesem Beispiel identifiziert ein geteiltes Präfix das
Deployment, und Springs `${random.uuid}` liefert den pro-Instanz-Suffix:

```yaml
app:
  config-topic: ${CONFIG_TOPIC:local-cache-config}
  kafka:
    bootstrap-servers: ${KAFKA_BOOTSTRAP_SERVERS:localhost:9092}
    consumer-group: ${CONSUMER_GROUP_PREFIX:local-cache-demo}-${random.uuid}
```

Jeder Start erzeugt eine neue Group und muss ihren lokalen Cache neu aufbauen. Deshalb setze
`auto.offset.reset` in den Consumer-Properties auf `earliest`. `latest` würde einen neuen Pod
leer lassen, bis das nächste Update eintrifft.

```java
Map<String, Object> consumerProperties = Map.of(
        // other consumer properties...
        ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
```

Mit Topic und Broadcast-Verhalten können nun alle Pods denselben lokalen State
materialisieren.

## Updates im lokalen Cache materialisieren

Sobald der Topic den aktuellen State enthält und jeder Pod ihn erhält, ist der Listener bewusst
klein: Normale Records landen im lokalen Cache, bei einem Tombstone wird der Key entfernt.

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

Normale Records decken Creates und Updates ab. Die Löschung braucht eine zusätzliche Konvention.

## Konfiguration mit Tombstones löschen

Ein Record mit demselben Key und einem **null-Wert** ist ein **Tombstone**. Die Kompaktierung
behält ihn lange genug, damit Consumer die Löschung sehen, und entfernt ihn irgendwann.
`delete.retention.ms` ist auch die Grenze, innerhalb derer ein Consumer ab Offset null seinen
Scan abschließen muss, um garantiert einen gültigen End-State-Snapshot zu erhalten, wie die
[Kafka-Broker-Konfigurationsreferenz](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_log.cleaner.delete.retention.ms)
erklärt. Dimensioniere dieses Fenster anhand der gemessenen Worst-Case-Replay-Zeit; nimm nicht
an, dass der Default für einen großen Topic automatisch sicher ist.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-tombstone-flow.svg' | relative_url }}"
       alt="Ein Konfigurations-Administrator publiziert einen null-Wert als Kafka-Tombstone, und jeder Pod konsumiert ihn und entfernt den entsprechenden Key aus seinem lokalen Cache">
  <figcaption>Der Tombstone wird wie jeder andere Record broadcastet; jeder Pod interpretiert seinen null-Wert als Aufforderung, den Key zu entfernen.</figcaption>
</figure>

Harte Löschung passt nur, wenn die Anwendung die Konfiguration wirklich vergessen soll. Muss
eine inaktive Konfiguration für ein Audit, ältere Daten oder eine spätere Reaktivierung verfügbar
bleiben, publiziere stattdessen einen normalen Record mit `active: false` oder `deactivatedAt`
und behalte ihn im Cache. Ist die Zahl der Einträge klein, kann es einfacher sein, jede
Konfiguration lokal vorzuhalten. Ein kompaktierter Topic behält den neuesten Wert je Key, nicht
jede Revision für immer; nutze versionierte Keys oder einen separaten History-Topic, wenn die
vollständige Historie gebraucht wird.

Das Beispiel nutzt eine `ConcurrentHashMap` für `LocalConfigCache`. Spring Kafka startet
standardmäßig mit einem Consumer-Thread, aber konfigurierte Listener-Concurrency kann denselben
Cache aus mehreren Threads aktualisieren. Die `@ConfigConsumer`-Annotation am Listener verbindet
ihn mit dem Readiness Gate, das als Nächstes beschrieben wird.

An diesem Punkt kann jeder Pod den korrekten lokalen State aufbauen. Nutzen darf er diesen State
noch nicht, bevor das Replay abgeschlossen ist.

## Kein Traffic, bis du aufgeholt hast

> Nimm keinen Traffic an, führe keine Scheduled Jobs aus und leiste keine andere externe Arbeit,
> bis die Konfiguration konsumiert wurde.

Diesen Teil überspringt man leicht, und das Überspringen wird teuer. Ein Pod, der „ready“ meldet,
sobald ihm Partitionen zugewiesen sind, ist nur dem Namen nach bereit — er hat vielleicht drei
von dreitausend Records replayt. Requests treffen auf einen fast leeren Cache; ein Scheduled Job
läuft mit veralteten Defaults; niemand merkt es, bis jemand fragt, warum Pod 14 nach einem Deploy
zwei Minuten lang anders gehandelt hat.

Das Beispiel verpackt dieses Anliegen als kleines `readiness-gate`-Modul. Wenn Kafka Partitionen
zuweist, erfasst das Gate ihre aktuellen End-Offsets als Startup-Ziel. Jeder erfolgreich
verarbeitete Record bringt die getrackte Position seiner Partition voran. Die Readiness öffnet
erst, wenn jede Partition ihr erfasstes Ziel erreicht und kein Verarbeitungsfehler mehr offen
ist. Leere Topics funktionieren ebenfalls: Ihre Startpositionen entsprechen bereits ihren
End-Offsets.

Das Ziel ist ein fester Snapshot. Records, die nach der Partitionszuweisung publiziert werden,
erweitern ihn nicht, also kann ein fortlaufend aktualisierter Topic den Pod nicht endlos im
Startup halten. Sobald das erfasste Ziel erreicht ist, laufen spätere Records über den normalen
Live-Update-Pfad weiter und bleiben dem unten beschriebenen Eventual-Consistency-Trade-off
unterworfen.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-readiness-gate.svg' | relative_url }}"
       alt="Vier Phasen des Readiness Gates: Konfigurations-Consumer registrieren, feste Partition-Ziele erfassen, Records replayen und Positionen erst nach Erfolg voranbringen, dann Readiness öffnen, wenn alle Ziele erreicht sind">
  <figcaption>Das Gate startet geschlossen, trackt erfolgreiches Replay gegen feste Ziele und öffnet erst, wenn jede zugewiesene Partition aufgeholt hat.</figcaption>
</figure>

Der Ablauf hat vier Verantwortlichkeiten. Zuerst identifiziert eine Marker-Annotation die
`@KafkaListener`-Methode, deren `ConsumerRecord`-Argumente das Readiness Gate trackt:

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface ConfigConsumer {
    String value() default "";
}
```

Zweitens zeichnet der Tracker die bei der Zuweisung erfassten Ziel-End-Offsets und den nächsten
Offset nach jedem erfolgreich verarbeiteten Record auf:

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

`ConsumerReplayProgress` besitzt die zugewiesenen Partitionen, während ein kleines
`PartitionReplayProgress` die aktuelle Position, das feste Ziel und den Fehler einer Partition
besitzt. Diese Verantwortlichkeiten getrennt zu halten, macht die Readiness-Regel explizit: Jede
zugewiesene Partition muss ihr eigenes Ziel erreichen, und ein Fehler wird nur durch einen
erfolgreichen Record aus derselben Partition geräumt.

Ein `@Around`-Aspect meldet jeden erfolgreich verarbeiteten `ConsumerRecord` automatisch an den
Tracker — die Listener-Methode selbst ruft ihn nie direkt auf; deshalb enthält
`ConfigTopicListener.onMessage` oben überhaupt keinen readiness-bezogenen Code, nur die
`@ConfigConsumer("config-topic")`-Annotation. Ein separater Registrar registriert jede
`@ConfigConsumer`-Methode vorab beim Startup, bevor die erste Nachricht eintrifft. Ein
`ConsumerAwareRebalanceListener` liefert Zuweisungen samt deren erfassten End-Offsets. Das hält
die Readiness vom Startup an auf `DOWN`, bis der Listener durch alle Ziele verarbeitet hat, und
berechnet das Ziel nach einem Rebalance neu.

Drittens: Lege das Gate über einen normalen `HealthIndicator` in Spring Boots **Readiness**-Health-Group
offen. Das komponiert den Cache-State mit Boots eigener Readiness und gibt der Deployment-Plattform
einen stabilen Endpunkt zum Pollen. Es vermeidet auch, mit Boots Application-Availability-Events
während des Startups zu konkurrieren:

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

`/actuator/health/readiness` meldet `UP` erst, wenn jede zugewiesene Partition ihr erfasstes
Startup-Ziel erreicht hat. Konfiguriere die Deployment-Plattform so, dass sie den Traffic
zurückhält, bis dieser Endpunkt Erfolg zurückgibt.

Der Docker-Compose-Service des Beispiels nutzt denselben Endpunkt als `healthcheck`, also
markiert Docker die Anwendung erst als gesund, nachdem das Replay abgeschlossen ist. Das
spiegelt den Availability-Check einer Deployment-Plattform wider; Composes Health-Status selbst
steuert kein Traffic-Routing.

Viertens: Scheduled Jobs (oder jede andere Bean-Methode) auf dieselbe Weise gaten, ohne die
`if (!tracker.isFullyConsumed()) return;`-Prüfung an jeder Aufrufstelle zu wiederholen: eine
zweite Annotation, `@ReadinessGated`, plus ihr eigener kleiner Aspect, der den Aufruf komplett
überspringt, bis das Gate öffnet — damit ist `CacheSnapshotJob.logSnapshot` oben tatsächlich
annotiert:

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

Gleiche Form wie der `@ConfigConsumer`-Aspect zuvor, nur in die andere Richtung gerichtet: Jener
*meldet* Aktivität an den Tracker, dieser *liest* sie und entscheidet, ob der Aufruf überhaupt
durchgelassen wird. Er ergibt nur bei `void`-Methoden Sinn — ein übersprungener Aufruf gibt
`null` zurück —, und genau das ist ein `@Scheduled`-Job.

### Das Readiness Gate anwenden

Die Anwendung muss jede Interaktion mit der Außenwelt blockieren, die von dieser Konfiguration
abhängt; sonst kann sie auf einem leeren oder veralteten Cache handeln. Das Beispiel
implementiert zwei solcher Gates, aber dasselbe Prinzip gilt weiterreichend.

Für HTTP-Traffic hält der `ConfigConsumptionHealthIndicator` den Readiness-Endpunkt auf `DOWN`,
bis das Replay abgeschlossen ist. Controller müssen `tracker.isFullyConsumed()` nicht in jedem
Endpunkt wiederholen, wenn die Deployment-Plattform diesen Endpunkt nutzt, um Traffic
zurückzuhalten. In Kubernetes etwa: Nutze eine `readinessProbe` fürs Routing und gib einer
`startupProbe` genug Zeit für ein großes initiales Replay:

```java
@GetMapping("/api/cache")
public ResponseEntity<Map<String, CacheEntry>> all() {
    return ResponseEntity.ok(cache.snapshot());
}
```

Bei einem Scheduled Job verhindert `@ReadinessGated` den Aufruf, bis derselbe Tracker bereit
ist:

```java
@ReadinessGated
@Scheduled(fixedDelayString = "${app.cache-snapshot-job.interval}")
public void logSnapshot() {
    log.info("Local cache holds {} entries", cache.size());
}
```

Andere externe Interaktionen brauchen ein äquivalentes Gate. Ein Queue-Listener, der von dieser
Konfiguration abhängt, sollte etwa nicht mit der Verarbeitung beginnen, bevor der Cache bereit
ist; regle das auf Listener-/Container-Ebene oder mit einer Acknowledgement-Strategie, die
Nachrichten nicht acknowledgiert und nicht verliert, während das Gate geschlossen ist. Dieses
Beispiel bietet Gates nur für HTTP-Traffic und Scheduled Jobs, aber dasselbe Readiness-Signal
kann äquivalenten Schutz für Queue-Consumer, ausgehende Aufrufe oder jede andere
konfigurationsabhängige Arbeit treiben.

## Wo dieses Pattern wehtut

Der Happy Path ist verführerisch: einmal replayen, dann lokale Reads bedienen. Die
operationalen Kosten erscheinen an den Rändern — Startup, Lag, Retention und Ausfall. Das sind
die Entscheidungen, die ich explizit machen würde, bevor ich mich für das Pattern entscheide.

### Jeder Neustart zahlt die Replay-Kosten

Eine neue Group hat keine Offsets, also baut jeder Pod von vorn auf. Die Kosten wachsen daher
mit den Records, die noch im kompaktierten Log stehen — nicht schlicht mit der Zahl der aktuellen
Keys, denn Kompaktierung ist asynchron und alte Segmente können eine Weile verbleiben. Miss die
Replay-Zeit mit produktionsnahen Daten und gib der `startupProbe` genug Budget. Kafka holt
Records bereits in Batches, also justiere `max.poll.records` und halte die Arbeit je Record
billig. Bei größeren Replays stelle den Listener auf Batch-Modus um und wende jede zurückgegebene
Liste in einem Aufruf an; der Tracking-Aspect des Beispiels unterstützt sowohl einzelne
`ConsumerRecord`-Argumente als auch iterierbare Batches. Ergänze Listener-Concurrency nur, wenn
der Topic genug Partitionen dafür hat. Drei Partitionen erlauben maximal drei Consumer-Threads in
einem Pod, parallel voranzukommen.
Das Worst-Case-Replay muss zudem in das Tombstone-Retention-Fenster des Topics passen, sonst ist
ein Scan ab Offset null nicht garantiert, einen gültigen Snapshot zu rekonstruieren.

Die erfassten Ziele bewegen sich nicht, wenn Producer während des Replays neue Records anhängen;
fortlaufende Schreibvorgänge machen das Startup also nicht unbegrenzt. Der bestehende Log
bestimmt die Startup-Zeit. Ist dieser Log groß genug, um die Readiness langsam oder
unvorhersehbar zu machen, liegt der Topic wahrscheinlich außerhalb des gedachten
Low-Volume-Konfigurations-Use Cases dieses Patterns.

### Eigene Groups hinterlassen temporäre Metadaten

Jeder Pod erzeugt eine neue Consumer Group. Nachdem der Pod verschwunden ist, bleiben seine
committed Offsets sichtbar, bis Kafka inaktive Group-Metadaten gemäß den
Broker-Retention-Einstellungen entfernt. Das ist meist operationaler Ballast, keine ewig
wachsende Live-Workload — aber es beeinflusst Dashboards und jede Automatisierung, die annimmt,
jede gelistete Group sei aktiv. Nutze ein erkennbares Präfix, überwache die
[Offset-Retention-Policy](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_offsets.retention.minutes)
des Brokers und filtere inaktive Groups im Tooling aus.

### Große Konfiguration gehört nicht in jeden Pod

Dieses Pattern passt gut zu einem kleinen, häufig gelesenen Konfigurationsset. Ist die
Konfiguration groß, ist es meist eine schlechte Idee, den ganzen Datensatz im lokalen Speicher zu
halten. Jeder Pod braucht genug Heap für seine eigene Kopie, und zusätzliche Pods multiplizieren
diese Speicherkosten. Halte große Konfiguration in einem gemeinsamen Store oder materialisiere
nur die kleine Teilmenge, die jeder Service tatsächlich braucht.

### Eventual Consistency gehört zum Vertrag

Jeder Pod konsumiert Updates unabhängig, also können zwei Pods kurzzeitig unterschiedliche Werte
zurückgeben. Ein langsamer Consumer, ein Rebalance, ein Retry oder ein Kafka-Ausfall kann diese
Lücke verlängern. Das ist akzeptabel für Feature Flags, Routing-Hinweise und andere
Konfiguration, die kurzlebige Veraltetheit toleriert; es passt schlecht für
Autorisierungsentscheidungen, Inventar, Guthaben oder jede Regel, die sich überall im selben
Augenblick ändern muss. Definiere die tolerierte Verzögerung, überwache sie, und mache das
Verhalten bei veralteten Daten für Aufrufer explizit, bevor du dich für dieses Design
entscheidest.

Diese Kosten machen das Pattern nicht falsch. Sie definieren seinen sinnvollen Bereich: kompakte,
replayfähige, eventually konsistente Referenzdaten mit einem sehr heißen Read-Pfad — und ein
Team, das mit dem Betrieb von Kafka bereits sicher ist.

<aside class="post-lab-cta">
  <span class="post-lab-cta-label">Interactive Production-Lab</span>
  <h2>Kannst du diese Architektur am Leben halten?</h2>
  <p>Diagnostiziere vier Ausfälle rund um Consumer Groups, Startup-Replay, Readiness und
  Tombstones. Dauert etwa fünf Minuten.</p>
  <a href="{{ '/labs/kafka-local-cache/' | relative_url }}" class="btn-primary">
    Incident Lab starten <i class="fas fa-arrow-right"></i>
  </a>
</aside>

## Code

Der Code zu diesem Artikel ist verfügbar unter
**[github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article](https://github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article)**.
Das README des Repositorys enthält die Setup- und Ausführungsanleitung, darunter, wie man
Consumer Groups inspiziert, die Tombstone-Propagation beobachtet und die Anwendung lokal
skaliert.

---

## Lass uns sprechen

Wenn du etwas Ähnliches betreibst — oder betrieben hast —, würde ich gerne hören, wo die
Trade-offs für dich gelandet sind. Kontaktlinks findest du im Footer.
