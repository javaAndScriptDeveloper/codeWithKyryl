---
layout: post
lang: fr
lang_key: local-cache-via-kafka
permalink: /fr/2026/08/08/local-cache-via-kafka/
title: "Kafka peut-il remplacer Redis pour la synchronisation de cache ? La réponse de la production"
date: 2026-08-08
tags: [kafka, spring-boot, java, distributed-systems]
excerpt: "Un thread Reddit demandait si Kafka peut remplacer Redis pour diffuser les mises à jour de cache à 25 pods Spring Boot. Voici un pattern que j'ai vu tenir en production pendant des années — un topic compacté, un consumer group par pod et une porte de readiness — avec un exemple docker-compose exécutable."
description: "Kafka vs Redis pour la synchro de cache entre pods Spring Boot ? Un pattern de production : topic compacté, consumer group par pod, gating de readiness."
tech_icon: "fas fa-stream"
faq:
  - question: "Kafka peut-il remplacer Redis pour la synchronisation de cache entre pods ?"
    answer: "Oui, pour le travail précis consistant à **diffuser** l'état à chaque instance — c'est un autre outil faisant un travail voisin, pas un remplacement direct. Redis donne à chaque pod une seule vue de cache partagée, tandis que Kafka donne à chaque pod sa **propre** copie à cohérence éventuelle, construite en rejouant un topic compacté. Utilisez ce pattern quand la latence de lecture locale compte et qu'un léger retard temporaire après une mise à jour est acceptable."
  - question: "Avec N pods, chaque pod reçoit-il chaque message Kafka, ou Kafka répartit-il les messages entre eux ?"
    answer: "Cela dépend entièrement du **consumer group**, pas de Kafka lui-même. Des pods partageant un même consumer group se répartissent les partitions (load-balancing) — chaque message va à exactement un pod. Donnez à chaque pod son **propre** consumer group distinct et chaque groupe reçoit le topic complet indépendamment, donc chaque pod voit chaque message. C'est le pattern de broadcast couvert par cet article."
  - question: "Comment donner à chaque pod son propre consumer group Kafka ?"
    answer: "Combinez un préfixe contrôlé par l'humain avec la valeur par instance `${random.uuid}` de Spring : `group-id: ${CONSUMER_GROUP_PREFIX}-${random.uuid}`. Chaque instance de l'application obtient un groupe unique, donc chaque pod consomme le topic complet indépendamment."
  - question: "Comment supprimer une clé quand le topic Kafka est compacté ?"
    answer: "Publiez un **tombstone** : un enregistrement avec la même clé et une valeur **null**. Les consommateurs qui le rencontrent évincent la clé au lieu de mettre null en cache. Kafka finit par supprimer à la fois la valeur remplacée et le tombstone ; dimensionnez `delete.retention.ms` pour qu'un replay complet puisse se terminer dans cette fenêtre, que la documentation de Kafka présente comme la borne pour reconstruire un instantané valide depuis l'offset zéro."
  - question: "Les jobs planifiés et le trafic doivent-ils attendre que la consommation Kafka soit à jour ?"
    answer: "Oui. Un pod qui commence à servir des requêtes ou à exécuter des jobs planifiés avant d'avoir rejoué le topic travaille à partir d'un cache vide ou partiel. Gardez la readiness `DOWN` jusqu'à la fin du replay de démarrage. L'exemple capture l'end offset de chaque partition au moment de son assignation et n'ouvre la readiness qu'une fois que chaque position traitée atteint sa cible."
  - question: "Des mises à jour continues peuvent-elles bloquer un nouveau pod en démarrage pour toujours ?"
    answer: "Non. La porte de readiness capture un end offset figé pour chaque partition quand Kafka l'assigne. Les enregistrements ajoutés après cet instantané ne déplacent pas la cible de démarrage ; le pod les traite comme des mises à jour normales à cohérence éventuelle. Le démarrage peut néanmoins prendre beaucoup de temps quand le log compacté existant est volumineux, ce qui est une des raisons pour lesquelles ce pattern convient mieux aux petits topics d'upsert à faible volume comme les feature flags et la configuration des services."
---

# Kafka peut-il remplacer Redis pour la synchronisation de cache ? La réponse de la production

Je suis récemment tombé sur une question sur r/apachekafka qui résume un problème courant de synchronisation
de cache :
**[Kafka peut-il remplacer Redis pour la synchronisation de cache entre plusieurs pods Spring Boot ?](https://www.reddit.com/r/apachekafka/comments/1vhv9nn/can_kafka_replace_redis_for_cache_synchronization/)**

<blockquote class="post-question">
  <span class="post-question-label">La question d'origine, reformulée</span>
  <p>Spring Boot sur GCP, environ 25 pods, Redis gère actuellement la synchronisation de cache. On envisage Kafka
  à la place : publier un événement quand une entrée de cache change, chaque pod le consomme et met à jour son
  propre cache local. Kafka est-il adapté ici ? Avec 25 pods, est-ce que chaque pod reçoit la mise à jour, ou
  Kafka ne la remet-il qu'à un seul consommateur ? Chaque pod a-t-il besoin de son propre consumer group ? Quelqu'un
  a-t-il réellement fait tourner cela — quels sont les avantages et les inconvénients ?</p>
</blockquote>

J'ai de l'expérience dans la résolution de cette classe de problèmes. L'approche décrite ici — un topic Kafka
compacté utilisé pour matérialiser un cache local dans chaque pod — est un pattern courant qui tourne depuis des
années dans des systèmes en production. Ce n'est pas un remplacement universel de Redis, mais c'est une option
pratique quand ses compromis de cohérence et d'exploitation correspondent à la charge de travail. Cet article
explique le pattern, les détails qui comptent en pratique, et un petit exemple exécutable.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-flow.svg' | relative_url }}"
       alt="Un producteur de configuration publie vers un topic Kafka compacté, que trois consumer groups rejouent dans des caches locaux séparés dans le pod A, le pod B et le pod C">
  <figcaption>Chaque pod utilise un consumer group séparé, reçoit le topic complet et sert les lectures depuis son propre cache local.</figcaption>
</figure>

## Le problème : une configuration partagée sur un chemin de lecture rapide

Supposez que l'application possède des données de configuration ou de référence dont chaque instance a souvent
besoin : règles de fonctionnalités, paramètres de routage, réglages par tenant, ou données similaires. Elles
doivent être rapides à récupérer, mais elles doivent aussi pouvoir changer sans redéployer chaque pod.

Un cache Redis partagé est une solution naturelle. Chaque pod lit la même valeur gérée de manière centrale, donc
après une mise à jour il n'y a qu'une seule vue courante à consulter. Le compromis, c'est que chaque lecture
sort du processus et dépend de la disponibilité et de la réactivité du service de cache. Selon la stratégie de
cache choisie, un miss Redis peut aussi entraîner une lecture supplémentaire : avec le cache-aside, par exemple,
l'application lit la source de vérité, puis remplit Redis avant que la requête suivante puisse utiliser le
cache.

Kafka adopte une approche différente. Une mise à jour est ajoutée à un topic compacté, et chaque instance rejoue
ce topic dans son propre cache en mémoire. Les lectures deviennent alors des accès à une map locale. Les réplicas
sont à cohérence éventuelle : quand un pod commence à traiter du travail, il peut encore avoir une valeur plus
ancienne le temps de rattraper son retard — ou aucune valeur du tout si la consommation a échoué. Plus loin, je
montrerai comment empêcher un pod de faire un vrai travail tant qu'il n'a pas consommé la configuration. En
échange, Kafka fournit un log durable pour le replay et la récupération, garde le chemin de lecture à
l'intérieur du pod, et peut supporter une sérialisation explicite basée sur des schémas comme Avro, Protobuf ou
JSON Schema.

Ni Kafka ni Redis n'est à l'abri des pannes. Mais si Kafka est déjà une dépendance, l'utiliser pour distribuer
cette configuration permet d'éviter d'ajouter Redis comme dépendance d'exécution supplémentaire et comme
système de plus à exploiter. Cela réduit le nombre de pièces mobiles et de modes de panne à considérer ; cela ne
fait pas disparaître les pannes de Kafka. Ce n'est un compromis judicieux que si la cohérence éventuelle est
acceptable pour les données.

Kafka peut aussi découpler le service qui publie la configuration des services qui la consomment. Ils n'ont
besoin de se mettre d'accord que sur le contrat d'enregistrement et son schéma ; les consommateurs n'ont pas
besoin d'une dépendance d'exécution directe au producteur. Avec Redis, les deux côtés doivent généralement se
mettre d'accord sur le format des clés et la valeur sérialisée — souvent le même DTO ou une représentation
partagée — et les consommateurs doivent savoir où la lire.

| Aspect | Redis (cache partagé) | Kafka (topic compacté → cache local) |
|---|---|---|
| Vue des données | Un cache géré centralement | Un cache matérialisé par instance |
| Cohérence | Une seule vue de cache partagée ; les changements de la source exigent toujours une invalidation correcte | Cohérence éventuelle entre réplicas locaux |
| Chemin de lecture | Aller-retour réseau ; les miss peuvent exiger une lecture de la source de vérité | Accès à une map dans le processus après le replay initial |
| Reprise / nouvelles instances | Remplir ou préchauffer le cache | Rejouer le topic compacté |
| Historique des enregistrements | Pas inhérent au cache | État courant rejouable ; la compaction supprime les valeurs remplacées, ce n'est donc pas un log d'audit |
| Couplage des services | Format clé/valeur partagé et accès Redis | Schéma d'enregistrement partagé ; aucune dépendance directe au producteur |
| Coût opérationnel | Un tier de cache partagé, plus Kafka s'il est aussi nécessaire | Stockage Kafka, consommateurs, et un cache par instance |

Cet article se concentre sur la construction sûre du côté Kafka : diffuser chaque mise à jour à chaque
instance, reconstruire le cache au démarrage, et refuser de faire un vrai travail tant que cette reconstruction
n'est pas terminée.

**Une note sur le code** : le dépôt est une démonstration exécutable, pas une bibliothèque de production prête
à l'emploi. J'ai vérifié son flux Docker de bout en bout : replay de démarrage, readiness, mises à jour en
direct et éviction par tombstone. Avant d'adopter le pattern, testez-le contre vos propres scénarios de volume,
de rebalance, de sérialisation, de retry et de panne.

<div class="post-tldr" markdown="1">
<p class="post-tldr-title">TL;DR</p>

- **Oui, avec une réserve** : Kafka remplace Redis pour *diffuser* l'état à chaque pod, pas pour
  lire depuis un seul cache partagé. Chaque pod obtient sa propre copie locale à cohérence éventuelle.
- **Chaque pod a besoin de son propre consumer group Kafka.** Des pods partageant un groupe se répartissent les
  partitions (load-balancing) ; des pods ayant chacun leur groupe reçoivent chacun le topic complet (broadcast).
- Le topic doit être **compacté**. Utilisez plusieurs partitions quand le replay de démarrage a besoin de
  concurrence, et rendez le cache local **thread-safe** quand la concurrence du listener est activée.
- Gardez le jeu de données **petit et de volume relativement faible**. Ce pattern convient aux feature flags, aux
  règles de routage et à la configuration des services — pas à un jeu de données métier volumineux ou à forte rotation.
- **Les suppressions sont des tombstones** : un enregistrement avec une valeur null, pas un type de message
  « delete » spécial.
- **Attendez la fin du replay de démarrage avant d'interagir avec le monde extérieur.**
  Ne servez pas d'endpoints, n'exécutez pas de jobs planifiés, ne traitez pas de messages de file, n'effectuez
  aucun autre travail visible de l'extérieur à partir d'un cache local partiel. Ouvrez la readiness seulement
  après que le replay est terminé.
- Les groupes uniques laissent derrière eux des métadonnées d'offsets inactives jusqu'à ce que la rétention
  configurée de Kafka les supprime. Attendez-vous à un encombrement temporaire dans les outils de consumer
  groups et surveillez les réglages de broker concernés.
</div>

---

## Comment fonctionne l'ensemble du flux

Il y a deux phases : **reconstruire le réplica local**, puis **le maintenir à jour**.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-lifecycle.svg' | relative_url }}"
       alt="Cycle de vie en deux phases du cache local Kafka : au démarrage, capture de cibles de partitions figées et readiness maintenue DOWN tant que les enregistrements sont appliqués ; en régime permanent, ouverture de la readiness, service des lectures locales et poursuite de l'application des mises à jour ultérieures">
  <figcaption>Le démarrage a une ligne d'arrivée figée. Une fois que chaque partition l'a atteinte, le même listener maintient à jour le cache local du pod prêt.</figcaption>
</figure>

1. Un producteur écrit un upsert vers le topic compacté. La clé d'enregistrement Kafka est la clé de
   configuration ; sa valeur est la configuration la plus récente. Une valeur null est un tombstone qui signifie
   suppression.
2. Un nouveau pod démarre avec un nouveau consumer group et `auto.offset.reset=earliest`, ainsi Kafka assigne
   chaque partition du topic au groupe de ce pod et le replay commence depuis les offsets conservés les plus
   anciens.
3. Pendant l'assignation, la porte de readiness lit deux nombres pour chaque partition : la position courante du
   consommateur et l'end offset de la partition. Cet end offset devient la **cible de démarrage figée**.
4. Le listener applique chaque enregistrement à une map locale thread-safe. Ce n'est qu'après le retour réussi du
   listener que l'aspect de suivi avance la position traitée de cette partition. Un échec du listener ne peut
   donc pas faire prétendre à la porte que l'enregistrement en échec a été appliqué.
5. Quand chaque partition atteint sa cible capturée, la readiness passe à `UP`. La plateforme de déploiement peut
   alors router les requêtes vers le pod, et les jobs planifiés gated par la readiness peuvent s'exécuter. Les
   lectures utilisent la map locale et n'appellent pas Kafka.
6. Le même consommateur reste actif après le démarrage. Les nouveaux enregistrements mettent à jour ou
   suppriment les entrées locales à leur arrivée, ainsi les pods convergent indépendamment et sont à cohérence
   éventuelle entre eux.

La cible figée de l'étape 3 est importante. Si un producteur écrit pendant que le replay tourne, le nouvel
enregistrement ne repousse pas la ligne d'arrivée du démarrage pour toujours. Le consommateur le traite quand
même par le chemin normal du listener, mais la readiness est définie par rapport à l'instantané capturé à
l'assignation. Ce qui peut rendre le démarrage lent, c'est un log existant volumineux, pas un flux de mises à
jour ultérieures à faible volume. C'est pourquoi le pattern est destiné aux jeux de données d'upsert petits et
à faible rotation, comme les feature flags, les règles de routage et la configuration des services.

---

## Publier l'état courant dans un topic compacté

Commencez par créer le topic de configuration avec `cleanup.policy=compact`. La compaction conserve le dernier
enregistrement de chaque clé, ainsi un pod qui démarre plus tard peut rejouer le topic depuis le début et
reconstruire la configuration courante sans demander à un autre service de préchauffer son cache.

Cela fonctionne mieux pour un topic d'upsert petit et de volume relativement faible : feature flags, règles de
routage, réglages par tenant, ou configuration similaire. Ce n'est pas un bon défaut pour un jeu de données
volumineux ou à forte rotation que chaque pod devrait rejouer et retenir en mémoire.

Créez assez de partitions pour permettre à un pod de rejouer le topic concurremment avec plusieurs threads
consommateurs quand le temps de démarrage compte. La concurrence utile est plafonnée par le nombre de
partitions, et le cache local doit être thread-safe quand la concurrence du listener est configurée au-dessus
de un. Dans l'exemple, un service `kafka-topic-init` à exécution unique crée et alimente le topic avant que
l'application ne démarre.

L'exigence suivante est de garantir que chaque pod reçoit cet état.

## Donner à chaque pod son propre consumer group

Un consumer group Kafka a une vue indépendante d'un topic : au sein de ce groupe, chaque partition est assignée
à un consommateur. Par conséquent, les pods qui partagent un groupe se répartissent le travail ; les pods dans
des groupes séparés consomment chacun le topic complet.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-consumer-groups.svg' | relative_url }}"
       alt="Comparaison entre un consumer group Kafka partagé, où les partitions sont réparties entre les pods, et un groupe unique par pod, où chaque pod reçoit toutes les partitions">
  <figcaption>Un groupe partagé divise l'état. Un groupe unique par pod donne à chaque cache local l'état complet.</figcaption>
</figure>

Donnez à chaque pod un `group.id` unique. Dans cet exemple, un préfixe partagé identifie le déploiement et le
`${random.uuid}` de Spring fournit le suffixe par instance :

```yaml
app:
  config-topic: ${CONFIG_TOPIC:local-cache-config}
  kafka:
    bootstrap-servers: ${KAFKA_BOOTSTRAP_SERVERS:localhost:9092}
    consumer-group: ${CONSUMER_GROUP_PREFIX:local-cache-demo}-${random.uuid}
```

Chaque démarrage crée un nouveau groupe et doit reconstruire son cache local. Pour cette raison, réglez
`auto.offset.reset` à `earliest` dans les propriétés du consommateur. `latest` laisserait un nouveau pod vide
jusqu'à l'arrivée de la prochaine mise à jour.

```java
Map<String, Object> consumerProperties = Map.of(
        // other consumer properties...
        ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
```

Avec le topic et le comportement de broadcast en place, chaque pod peut désormais matérialiser le même état
local.

## Matérialiser les mises à jour dans le cache local

Une fois que le topic contient l'état courant et que chaque pod le reçoit, le listener est délibérément petit :
mettre les enregistrements normaux dans le cache local et supprimer une clé pour un tombstone.

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

Les enregistrements normaux couvrent les créations et les mises à jour. La suppression nécessite une convention
supplémentaire.

## Supprimer la configuration avec des tombstones

Un enregistrement avec la même clé et une **valeur null** est un **tombstone**. La compaction le conserve assez
longtemps pour que les consommateurs observent la suppression, puis finit par le retirer. `delete.retention.ms`
est aussi la borne dans laquelle un consommateur démarrant à l'offset zéro doit terminer son scan pour être
garanti d'obtenir un instantané valide de l'état final, comme l'explique la
[référence de configuration des brokers Kafka](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_log.cleaner.delete.retention.ms).
Configurez cette fenêtre à partir d'un temps de replay mesuré au pire cas ; ne partez pas du principe que le
défaut est automatiquement sûr pour un grand topic.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-tombstone-flow.svg' | relative_url }}"
       alt="Un administrateur de configuration publie une valeur null comme tombstone Kafka, et chaque pod le consomme et supprime la clé correspondante de son cache local">
  <figcaption>Le tombstone est diffusé comme n'importe quel autre enregistrement ; chaque pod interprète sa valeur null comme une instruction de supprimer la clé.</figcaption>
</figure>

La suppression physique n'est appropriée que lorsque l'application doit réellement oublier la configuration. Si
une configuration inactive doit rester disponible pour un audit, des données plus anciennes ou une réactivation
ultérieure, publiez plutôt un enregistrement normal avec `active: false` ou `deactivatedAt` et gardez-le dans le
cache. Si le nombre d'entrées est petit, retenir chaque configuration localement peut être plus simple. Un topic
compacté garde la dernière valeur par clé, pas chaque révision pour toujours ; utilisez des clés versionnées ou
un topic d'historique séparé quand l'historique complet est requis.

L'exemple utilise un `ConcurrentHashMap` pour `LocalConfigCache`. Spring Kafka démarre avec un seul thread
consommateur par défaut, mais la concurrence de listener configurée peut mettre à jour le même cache depuis
plusieurs threads. L'annotation `@ConfigConsumer` sur le listener le relie à la porte de readiness décrite
ensuite.

À ce stade, chaque pod peut construire l'état local correct. Il ne doit toujours pas utiliser cet état tant que
le replay n'est pas terminé.

## Ne servez pas le trafic tant que vous n'avez pas rattrapé votre retard

> Ne recevez pas de trafic, n'exécutez pas de jobs planifiés et n'effectuez aucun autre travail externe tant que
> la configuration n'a pas été consommée.

C'est la partie qu'il est facile d'escamoter et coûteux d'escamoter. Un pod qui se déclare « prêt » dès qu'on
lui assigne des partitions n'est prêt que de nom — il a peut-être rejoué trois enregistrements sur trois mille.
Les requêtes frappent un cache presque vide ; un job planifié tourne sur des défauts périmés ; personne ne le
remarque jusqu'à ce que quelqu'un demande pourquoi le pod 14 s'est comporté différemment pendant deux minutes
après un déploiement.

L'exemple empaquette cette préoccupation dans un petit module `readiness-gate`. Quand Kafka assigne des
partitions, la porte capture leurs end offsets courants comme cible de démarrage. Chaque enregistrement traité
avec succès avance la position suivie de sa partition. La readiness ne s'ouvre qu'après que chaque partition a
atteint sa cible capturée et qu'aucune erreur de traitement ne subsiste. Les topics vides fonctionnent aussi :
leurs positions de départ égalent déjà leurs end offsets.

La cible est un instantané figé. Les enregistrements publiés après l'assignation des partitions ne l'étendent
pas, ainsi un topic continuellement mis à jour ne peut pas garder le pod en démarrage pour toujours. Une fois la
cible capturée atteinte, les enregistrements ultérieurs continuent par le chemin normal des mises à jour en
direct et restent soumis au compromis de cohérence éventuelle décrit plus bas.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-readiness-gate.svg' | relative_url }}"
       alt="Quatre étapes de la porte de readiness : enregistrer le consumer de configuration, capturer des cibles de partitions figées, rejouer les enregistrements et n'avancer les positions qu'après succès, puis ouvrir la readiness quand toutes les cibles sont atteintes">
  <figcaption>La porte démarre fermée, suit le replay réussi par rapport à des cibles figées et ne s'ouvre que lorsque chaque partition assignée a rattrapé son retard.</figcaption>
</figure>

Le flux a quatre responsabilités. D'abord, une annotation marqueuse identifie la méthode `@KafkaListener` dont
les arguments `ConsumerRecord` sont suivis par la porte de readiness :

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface ConfigConsumer {
    String value() default "";
}
```

Ensuite, le traqueur enregistre les end offsets cibles capturés à l'assignation et l'offset suivant après chaque
enregistrement traité avec succès :

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

`ConsumerReplayProgress` possède les partitions assignées, tandis qu'un petit
`PartitionReplayProgress` possède la position courante, la cible figée et l'erreur d'une partition. Garder ces
responsabilités séparées rend la règle de readiness explicite : chaque partition assignée doit atteindre sa
propre cible, et un échec n'est effacé que par un enregistrement réussi de cette même partition.

Un aspect `@Around` rapporte automatiquement au traqueur chaque `ConsumerRecord` traité avec succès — la
méthode du listener elle-même ne l'appelle jamais directement, c'est pourquoi `ConfigTopicListener.onMessage`
ci-dessus ne contient aucun code lié à la readiness, juste l'annotation `@ConfigConsumer("config-topic")`.
Un registrar séparé pré-enregistre chaque méthode `@ConfigConsumer` au démarrage, avant l'arrivée du premier
message. Un `ConsumerAwareRebalanceListener` fournit les assignations et leurs end offsets capturés. Cela
maintient la readiness `DOWN` depuis le démarrage jusqu'à ce que le listener ait traité jusqu'à chaque cible, et
recalcule la cible après un rebalance.

Troisièmement, exposez la porte via un `HealthIndicator` normal dans le groupe de santé **readiness** de Spring
Boot. Cela compose l'état du cache avec l'état de readiness propre à Boot et donne à la plateforme de
déploiement un endpoint stable à sonder. Cela évite aussi d'entrer en concurrence avec les événements de
disponibilité applicative de Boot pendant le démarrage :

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

`/actuator/health/readiness` rapporte désormais `UP` seulement après que chaque partition assignée a atteint sa
cible de démarrage capturée. Configurez la plateforme de déploiement pour retenir le trafic tant que cet
endpoint ne renvoie pas un succès.

Le service Docker Compose de l'exemple utilise le même endpoint comme `healthcheck`, ainsi Docker ne marque
l'application comme saine qu'après la fin du replay. Cela reflète la vérification de disponibilité d'une
plateforme de déploiement ; l'état de santé de Compose lui-même ne contrôle pas le routage du trafic.

Quatrièmement, gater les jobs planifiés (ou toute autre méthode de bean) de la même façon, sans répéter la
vérification `if (!tracker.isFullyConsumed()) return;` à chaque site d'appel : une seconde annotation,
`@ReadinessGated`, plus son propre petit aspect qui saute l'appel entièrement tant que la porte n'est pas
ouverte — c'est ce dont `CacheSnapshotJob.logSnapshot` ci-dessus est réellement annoté :

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

Même forme que l'aspect `@ConfigConsumer` plus tôt, juste pointé dans l'autre direction : celui-là *rapporte*
l'activité au traqueur, celui-ci la *lit* et décide s'il laisse passer l'appel. Cela n'a de sens que sur des
méthodes `void` — un appel sauté renvoie `null` — ce qui est exactement ce qu'est un job `@Scheduled`.

### Appliquer la porte de readiness

L'application doit bloquer toute interaction avec le monde extérieur qui dépend de cette configuration ;
sinon, elle peut agir sur un cache vide ou périmé. L'exemple implémente deux telles portes, mais le même
principe s'applique plus largement.

Pour le trafic HTTP, le `ConfigConsumptionHealthIndicator` maintient l'endpoint de readiness `DOWN` tant que le
replay n'est pas terminé. Les contrôleurs n'ont pas besoin de répéter `tracker.isFullyConsumed()` dans chaque
endpoint quand la plateforme de déploiement utilise cet endpoint pour retenir le trafic. Par exemple, dans
Kubernetes, utilisez une `readinessProbe` pour le routage et donnez à une `startupProbe` assez de temps pour un
replay initial volumineux :

```java
@GetMapping("/api/cache")
public ResponseEntity<Map<String, CacheEntry>> all() {
    return ResponseEntity.ok(cache.snapshot());
}
```

Pour un job planifié, `@ReadinessGated` empêche l'invocation tant que le même traqueur n'est pas prêt :

```java
@ReadinessGated
@Scheduled(fixedDelayString = "${app.cache-snapshot-job.interval}")
public void logSnapshot() {
    log.info("Local cache holds {} entries", cache.size());
}
```

Les autres interactions externes ont besoin d'une porte équivalente. Par exemple, un listener de file qui dépend
de cette configuration ne devrait pas commencer le traitement tant que le cache n'est pas prêt ; arrangez cela
au niveau du listener/conteneur ou avec une stratégie d'acquittement qui n'acquitte ni ne perd de messages tant
que la porte est fermée. Cet exemple fournit des portes pour le trafic HTTP et les jobs planifiés seulement,
mais le même signal de readiness peut piloter une protection équivalente pour les consommateurs de files, les
appels sortants, ou tout autre travail dépendant de la configuration.

## Là où ce pattern mord

Le chemin nominal est séduisant : rejouer une fois, puis servir des lectures locales. Le coût opérationnel
apparaît aux frontières — démarrage, lag, rétention et panne. Voici les décisions que je rendrais explicites
avant de choisir le pattern.

### Chaque redémarrage paie le coût du replay

Un nouveau groupe n'a pas d'offsets, donc chaque pod reconstruit depuis le début. Le coût croît donc avec les
enregistrements encore présents dans le log compacté — pas simplement avec le nombre de clés courantes, car la
compaction est asynchrone et d'anciens segments peuvent subsister un moment. Mesurez le temps de replay avec des
données proches de la production et donnez à la `startupProbe` un budget suffisant. Kafka récupère déjà les
enregistrements par lots, donc ajustez `max.poll.records` et gardez le travail par enregistrement bon marché.
Pour des replays plus importants, passez le listener en mode batch et appliquez chaque liste retournée en une
seule invocation ; l'aspect de suivi de l'exemple supporte aussi bien les arguments `ConsumerRecord`
individuels que les batches itérables. Ajoutez de la concurrence au listener seulement quand le topic a assez
de partitions pour l'utiliser. Trois partitions permettent au plus trois threads consommateurs dans un même pod
de progresser en parallèle.
Le replay au pire cas doit aussi tenir dans la fenêtre de rétention des tombstones du topic, sinon un scan
depuis l'offset zéro n'est pas garanti de reconstruire un instantané valide.

Les cibles capturées ne bougent pas quand les producteurs ajoutent de nouveaux enregistrements pendant le
replay, ainsi les écritures continues ne rendent pas le démarrage non borné. C'est le log existant qui détermine
le temps de démarrage. Si ce log est assez volumineux pour rendre la readiness lente ou imprévisible, le sujet
sort probablement du cas d'usage de configuration à faible volume prévu pour ce pattern.

### Les groupes uniques laissent des métadonnées temporaires

Chaque pod génère un nouveau consumer group. Après la disparition du pod, ses offsets commités restent visibles
jusqu'à ce que Kafka supprime les métadonnées de groupe inactives selon les réglages de rétention du broker.
C'est généralement de l'encombrement opérationnel, pas une charge de travail réelle en croissance perpétuelle,
mais cela affecte les tableaux de bord et toute automatisation qui suppose que chaque groupe listé est actif.
Utilisez un préfixe identifiable, surveillez la
[politique de rétention des offsets](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_offsets.retention.minutes)
du broker, et filtrez les groupes inactifs dans vos outils.

### Une configuration volumineuse n'a pas sa place dans chaque pod

Ce pattern convient bien à un petit jeu de configuration lu fréquemment. Si la configuration est volumineuse,
garder tout le jeu de données en mémoire locale est généralement une mauvaise idée. Chaque pod a besoin de
assez de heap pour sa propre copie, et ajouter des pods multiplie ce coût mémoire. Conservez une configuration
volumineuse dans un stockage partagé, ou matérialisez seulement le petit sous-ensemble dont chaque service a
réellement besoin.

### La cohérence éventuelle fait partie du contrat

Chaque pod consomme les mises à jour indépendamment, ainsi deux pods peuvent brièvement renvoyer des valeurs
différentes. Un consommateur lent, un rebalance, un retry ou une panne de Kafka peut prolonger cet écart. C'est
acceptable pour les feature flags, les indices de routage et les autres configurations qui tolèrent un léger
retard temporaire ; c'est un mauvais choix pour les décisions d'autorisation, l'inventaire, les soldes, ou toute
règle qui doit changer partout au même instant. Définissez le lag toléré, surveillez-le, et rendez le
comportement en cas de données périmées explicite pour les appelants avant de choisir cette conception.

Ces coûts ne rendent pas le pattern faux. Ils définissent son domaine d'utilité : des données de référence
compactes, rejouables, à cohérence éventuelle, avec un chemin de lecture très sollicité et une équipe déjà à
l'aise pour exploiter Kafka.

<aside class="post-lab-cta">
  <span class="post-lab-cta-label">Laboratoire de production interactif</span>
  <h2>Pouvez-vous garder cette architecture en vie ?</h2>
  <p>Diagnostiquez quatre pannes impliquant des consumer groups, le replay de démarrage, la readiness et les
  tombstones. Cela prend environ cinq minutes.</p>
  <a href="{{ '/labs/kafka-local-cache/' | relative_url }}" class="btn-primary">
    Lancer le laboratoire d'incidents <i class="fas fa-arrow-right"></i>
  </a>
</aside>

## Code

Le code de cet article est disponible sur
**[github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article](https://github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article)**.
Le README du dépôt contient les instructions d'installation et d'exécution, notamment comment inspecter les
consumer groups, observer la propagation des tombstones et mettre à l'échelle l'application localement.

---

## Discutons-en

Si vous faites tourner — ou avez fait tourner — quelque chose de similaire, j'aimerais savoir où les compromis
sont tombés pour vous. Les liens de contact sont dans le pied de page.
