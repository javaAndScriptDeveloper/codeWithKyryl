---
layout: post
lang: es
lang_key: local-cache-via-kafka
permalink: /es/2026/08/08/local-cache-via-kafka/
title: "¿Puede Kafka reemplazar a Redis para sincronizar cachés? Una respuesta de producción"
date: 2026-08-08
tags: [kafka, spring-boot, java, distributed-systems]
excerpt: "Un hilo de Reddit preguntaba si Kafka puede reemplazar a Redis para difundir actualizaciones de caché a 25 pods de Spring Boot. Aquí va un patrón que he visto sostenerse en producción por años — un topic compactado, un grupo de consumo por pod y una compuerta de readiness — con un ejemplo de docker-compose ejecutable."
description: "¿Puede Kafka reemplazar a Redis para sincronizar cachés entre pods de Spring Boot? Patrón de producción: topic compactado, grupos por pod, readiness gating."
tech_icon: "fas fa-stream"
faq:
  - question: "¿Puede Kafka reemplazar a Redis para la sincronización de cachés entre pods?"
    answer: "Sí, para el trabajo específico de **difundir** estado a cada instancia — es una herramienta distinta haciendo un trabajo relacionado, no un reemplazo directo. Redis le da a cada pod una única vista de caché compartida, mientras que Kafka le da a cada pod su **propia** copia eventualmente consistente construida reprocesando un topic compactado. Usa este patrón cuando la latencia de lectura local importa y una desactualización breve tras una actualización es aceptable."
  - question: "Con N pods, ¿cada pod recibe todos los mensajes de Kafka o Kafka los reparte entre ellos?"
    answer: "Depende por completo del **grupo de consumo** (consumer group), no de Kafka en sí. Los pods que comparten un grupo se reparten las particiones entre ellos (balanceo de carga) — cada mensaje va exactamente a un pod. Dale a cada pod su **propio** grupo de consumo distinto y cada grupo obtiene el topic completo de forma independiente, así que cada pod ve todos los mensajes. Ese es el patrón de difusión (broadcast) que cubre este artículo."
  - question: "¿Cómo le doy a cada pod su propio grupo de consumo de Kafka?"
    answer: "Combina un prefijo controlado por humanos con el valor por instancia `${random.uuid}` de Spring: `group-id: ${CONSUMER_GROUP_PREFIX}-${random.uuid}`. Cada instancia de la aplicación obtiene un grupo único, así que cada pod consume el topic completo de forma independiente."
  - question: "¿Cómo eliminas una clave cuando el topic de Kafka está compactado?"
    answer: "Publica un **tombstone**: un registro con la misma clave y un valor **null**. Los consumidores que lo encuentran expulsan la clave en lugar de cachear null. Kafka eventualmente elimina tanto el valor reemplazado como el tombstone; dimensiona `delete.retention.ms` de modo que un reproceso completo pueda terminar dentro de esa ventana, que la documentación de Kafka marca como el límite para reconstruir un snapshot válido desde el offset cero."
  - question: "¿Deberían los jobs programados y el tráfico esperar a que el consumo de Kafka se ponga al día?"
    answer: "Sí. Un pod que empieza a servir peticiones o a ejecutar jobs programados antes de haber reprocesado el topic está trabajando con una caché vacía o parcial. Mantén el readiness en `DOWN` hasta que el reproceso de arranque esté completo. El ejemplo captura el end offset de cada partición cuando se la asignan y abre el readiness solo después de que cada posición procesada alcanza su objetivo."
  - question: "¿Pueden las actualizaciones continuas dejar un pod nuevo atascado en el arranque para siempre?"
    answer: "No. La compuerta de readiness captura un end offset fijo para cada partición cuando Kafka la asigna. Los registros agregados después de ese snapshot no mueven el objetivo de arranque; el pod los procesa con normalidad como actualizaciones eventualmente consistentes. El arranque aún puede tardar mucho cuando el log compactado existente es grande, que es una de las razones por las que este patrón es mejor para topics de upsert pequeños y de bajo volumen, como feature flags y configuración de servicios."
---

# ¿Puede Kafka reemplazar a Redis para la sincronización de cachés? Una respuesta de producción

Recientemente me topé con una pregunta en r/apachekafka que captura un problema común de
sincronización de cachés:
**[¿Puede Kafka reemplazar a Redis para la sincronización de cachés en múltiples pods de Spring Boot?](https://www.reddit.com/r/apachekafka/comments/1vhv9nn/can_kafka_replace_redis_for_cache_synchronization/)**

<blockquote class="post-question">
  <span class="post-question-label">La pregunta original, parafraseada</span>
  <p>Spring Boot en GCP, ~25 pods, Redis maneja actualmente la sincronización de cachés. Considerando
  Kafka en su lugar: publicar un evento cuando cambia una entrada de la caché, cada pod lo consume y
  actualiza su propia caché local. ¿Es Kafka una buena opción aquí? Con 25 pods, ¿cada pod recibe la
  actualización o Kafka se la entrega a un solo consumidor? ¿Cada pod necesita su propio grupo de
  consumo? ¿Alguien ha corrido esto en producción — cuáles son los pros y los contras?</p>
</blockquote>

Tengo experiencia resolviendo esta clase de problemas. El enfoque descrito aquí — un topic de
Kafka compactado usado para materializar una caché local en cada pod — es un patrón común y ha
estado corriendo en sistemas de producción por años. No es un reemplazo universal de Redis, pero
es una opción práctica cuando sus trade-offs de consistencia y operación se ajustan a la carga de
trabajo. Este artículo explica el patrón, los detalles que importan en la práctica y un pequeño
ejemplo ejecutable.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-flow.svg' | relative_url }}"
       alt="Un productor de configuración publica en un topic de Kafka compactado, que tres grupos de consumo reprocesan en cachés locales separadas en el Pod A, el Pod B y el Pod C">
  <figcaption>Cada pod usa un grupo de consumo separado, recibe el topic completo y sirve lecturas desde su propia caché local.</figcaption>
</figure>

## El problema: configuración compartida en una ruta de lectura rápida

Asume que la aplicación tiene configuración o datos de referencia que cada instancia necesita con
frecuencia: reglas de features, ajustes de enrutamiento, configuración por tenant, o datos
similares. Debe ser rápido de obtener, pero también debe poder cambiar sin redeplegar todos los
pods.

Una caché Redis compartida es una solución natural. Cada pod lee el mismo valor gestionado
centralmente, así que tras una actualización hay una sola vista actual que consultar. El trade-off
es que cada lectura sale del proceso y depende de que el servicio de caché esté disponible y
responda rápido. Dependiendo de la estrategia de caché elegida, un miss de Redis también puede
causar una búsqueda adicional: con cache-aside, por ejemplo, la aplicación lee la fuente de
verdad y luego llena Redis antes de que la siguiente petición pueda usar la caché.

Kafka toma un enfoque distinto. Una actualización se agrega a un topic compactado, y cada
instancia reprocesa ese topic en su propia caché en memoria. Las lecturas son entonces búsquedas
en un mapa local. Las réplicas son eventualmente consistentes: cuando un pod empieza a procesar
trabajo, puede tener todavía un valor antiguo mientras se pone al día — o ningún valor si el
consumo ha fallado. Más adelante mostraré cómo evitar que un pod haga trabajo real hasta que haya
consumido la configuración. A cambio, Kafka provee un log durable para reproceso y recuperación,
mantiene la ruta de lectura dentro del pod, y puede soportar serialización explícita basada en
esquemas como Avro, Protobuf o JSON Schema.

Ni Kafka ni Redis son inmunes a las fallas. Pero si Kafka ya es una dependencia, usarlo para
distribuir esta configuración puede evitar agregar Redis como otra dependencia en tiempo de
ejecución y otro sistema que operar. Eso reduce el número de piezas móviles y modos de falla a
considerar; no hace desaparecer las fallas de Kafka. Este es un trade que vale la pena solo
cuando la consistencia eventual es aceptable para los datos.

Kafka también puede desacoplar el servicio que publica la configuración de los servicios que la
consumen. Solo necesitan acordar el contrato del registro y su esquema; los consumidores no
necesitan una dependencia directa en tiempo de ejecución del productor. Con Redis, ambos lados
típicamente necesitan acordar el formato de las claves y el valor serializado — a menudo el mismo
DTO o una representación compartida — y los consumidores deben saber dónde leerlo.

| Aspecto | Redis (caché compartida) | Kafka (topic compactado → caché local) |
|---|---|---|
| Vista de datos | Una caché gestionada centralmente | Una caché materializada por instancia |
| Consistencia | Una vista de caché compartida; los cambios en la fuente igual requieren invalidación correcta | Consistencia eventual entre réplicas locales |
| Ruta de lectura | Ida y vuelta por red; los misses pueden requerir consultar la fuente de verdad | Búsqueda en mapa dentro del proceso tras el replay inicial |
| Recuperación / instancias nuevas | Llenar o precalentar la caché | Reprocesar el topic compactado |
| Historial de registros | No es inherente a la caché | Estado actual reprocesable; la compactación elimina valores reemplazados, así que esto no es un log de auditoría |
| Acoplamiento de servicios | Formato clave/valor compartido y acceso a Redis | Esquema de registro compartido; sin dependencia directa del productor |
| Costo operativo | Una capa de caché compartida, más Kafka si también se necesita | Almacenamiento de Kafka, consumidores y una caché por instancia |

Este artículo se enfoca en cómo construir el lado de Kafka de forma segura: difundir cada
actualización a cada instancia, reconstruir la caché al arrancar y negarse a hacer trabajo real
hasta que esa reconstrucción esté completa.

**Una nota sobre el código**: el repositorio es una demostración ejecutable, no una librería de
producción lista para usar. Verifiqué su flujo de Docker de punta a punta: replay de arranque,
readiness, actualizaciones en vivo y expulsión por tombstone. Antes de adoptar el patrón,
pruébalo contra tus propios escenarios de volumen, rebalanceo, serialización, reintentos y caídas.

<div class="post-tldr" markdown="1">
<p class="post-tldr-title">TL;DR</p>

- **Sí, con una salvedad**: Kafka reemplaza a Redis para *difundir* estado a cada pod, no para leer de una única caché compartida. Cada pod obtiene su propia copia local eventualmente consistente.
- **Cada pod necesita su propio grupo de consumo de Kafka.** Los pods que comparten un grupo se reparten las particiones (balanceo de carga); los pods cada uno en su propio grupo obtienen cada uno el topic completo (broadcast).
- El topic debe estar **compactado**. Usa más de una partición cuando el replay de arranque necesite concurrencia, y haz la caché local **thread-safe** cuando la concurrencia del listener esté habilitada.
- Mantén el dataset **pequeño y de volumen relativamente bajo**. Este patrón sirve para feature flags, reglas de enrutamiento y configuración de servicios — no para un dataset de negocio grande o de alta rotación.
- **Los borrados son tombstones**: un registro con valor null, no un tipo de mensaje especial de "delete".
- **Espera a que el replay de arranque esté completo antes de interactuar con el mundo exterior.**
  No sirvas endpoints, no ejecutes jobs programados, no proceses mensajes de colas ni hagas otro
  trabajo externamente visible desde una caché local parcial. Abre el readiness solo cuando el
  replay esté completo.
- Los grupos únicos dejan atrás metadatos de offsets inactivos hasta que la retención configurada
  de Kafka los elimina. Espera desorden temporal en las herramientas de consumer groups y
  monitorea las configuraciones relevantes del broker.
</div>

---

## Cómo funciona el flujo completo

Hay dos fases: **reconstruir la réplica local** y luego **mantenerla actualizada**.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-lifecycle.svg' | relative_url }}"
       alt="Ciclo de vida de dos fases de la caché local con Kafka: el arranque captura objetivos fijos por partición y mantiene el readiness en DOWN mientras se aplican los registros; el estado estable abre el readiness, sirve lecturas locales y sigue aplicando actualizaciones posteriores">
  <figcaption>El arranque tiene una línea de meta fija. Después de que cada partición la alcanza, el mismo listener mantiene actualizada la caché local del pod listo.</figcaption>
</figure>

1. Un productor escribe un upsert al topic compactado. La clave del registro de Kafka es la clave
   de configuración; su valor es la configuración más reciente. Un valor null es un tombstone que
   significa borrado.
2. Un pod nuevo arranca con un grupo de consumo nuevo y `auto.offset.reset=earliest`, así que
   Kafka asigna cada partición del topic al grupo de ese pod y el replay comienza desde los
   offsets retenidos más antiguos.
3. Durante la asignación, la compuerta de readiness lee dos números por cada partición: la
   posición actual del consumidor y el end offset de la partición. Ese end offset se convierte en
   el **objetivo fijo de arranque**.
4. El listener aplica cada registro a un mapa local thread-safe. Solo después de que el listener
   retorna exitosamente el aspecto de tracking avanza la posición procesada de esa partición. Una
   falla del listener, por lo tanto, no puede hacer que la compuerta declare que el registro
   fallido fue aplicado.
5. Cuando cada partición alcanza su objetivo capturado, el readiness cambia a `UP`. La plataforma
   de despliegue puede ahora enrutar peticiones al pod, y los jobs programados protegidos por
   readiness pueden ejecutarse. Las lecturas usan el mapa local y no llaman a Kafka.
6. El mismo consumidor sigue activo después del arranque. Los registros nuevos actualizan o borran
   entradas locales a medida que llegan, así que los pods convergen de forma independiente y son
   eventualmente consistentes entre sí.

El objetivo fijo del paso 3 es importante. Si un productor escribe mientras el replay está
corriendo, el registro nuevo no aleja la línea de meta del arranque indefinidamente. El consumidor
igual lo procesa por la ruta normal del listener, pero el readiness se define contra el snapshot
capturado en la asignación. Lo que puede hacer lento el arranque es un log existente grande, no un
flujo de actualizaciones posteriores de bajo volumen. Por eso el patrón está pensado para datasets
de upsert pequeños y de baja rotación, como feature flags, reglas de enrutamiento y configuración
de servicios.

---

## Publica el estado actual en un topic compactado

Empieza creando el topic de configuración con `cleanup.policy=compact`. La compactación retiene
el último registro de cada clave, así que un pod que arranca después puede reprocesar el topic
desde el principio y reconstruir la configuración actual sin pedirle a otro servicio que
precaliente su caché.

Esto funciona mejor para un topic de upsert pequeño y de volumen relativamente bajo: feature
flags, reglas de enrutamiento, configuración por tenant, o configuración similar. No es un buen
defecto para un dataset grande o de alta rotación que cada pod tendría que reprocesar y retener en
memoria.

Crea suficientes particiones para permitir que un pod reprocese el topic concurrentemente con
varios hilos de consumo cuando el tiempo de arranque importa. La concurrencia útil está limitada
por el número de particiones, y la caché local debe ser thread-safe cuando la concurrencia del
listener se configura por encima de uno. En el ejemplo, un servicio `kafka-topic-init` de un solo
uso crea y siembra el topic antes de que arranque la aplicación.

El siguiente requisito es asegurar que cada pod reciba ese estado.

## Dale a cada pod su propio grupo de consumo

Un grupo de consumo de Kafka tiene una vista independiente de un topic: dentro de ese grupo, cada
partición se asigna a un consumidor. Por lo tanto, los pods que comparten un grupo se reparten el
trabajo; los pods en grupos separados consumen cada uno el topic completo.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-consumer-groups.svg' | relative_url }}"
       alt="Comparación entre un grupo de consumo de Kafka compartido, donde las particiones se reparten entre los pods, y un grupo único por pod, donde cada pod recibe todas las particiones">
  <figcaption>Un grupo compartido divide el estado. Un grupo único por pod le da a cada caché local el estado completo.</figcaption>
</figure>

Dale a cada pod un `group.id` único. En este ejemplo, un prefijo compartido identifica el
despliegue y el `${random.uuid}` de Spring provee el sufijo por instancia:

```yaml
app:
  config-topic: ${CONFIG_TOPIC:local-cache-config}
  kafka:
    bootstrap-servers: ${KAFKA_BOOTSTRAP_SERVERS:localhost:9092}
    consumer-group: ${CONSUMER_GROUP_PREFIX:local-cache-demo}-${random.uuid}
```

Cada arranque crea un grupo nuevo y debe reconstruir su caché local. Por esa razón, configura
`auto.offset.reset` en `earliest` en las propiedades del consumidor. `latest` dejaría un pod nuevo
vacío hasta que llegue la próxima actualización.

```java
Map<String, Object> consumerProperties = Map.of(
        // other consumer properties...
        ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
```

Con el topic y el comportamiento de broadcast en su lugar, cada pod puede ahora materializar el
mismo estado local.

## Materializa las actualizaciones en la caché local

Una vez que el topic contiene el estado actual y cada pod lo recibe, el listener es deliberadamente
pequeño: pone los registros normales en la caché local y elimina la clave para un tombstone.

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

Los registros normales cubren creaciones y actualizaciones. El borrado necesita una convención
adicional.

## Borra configuración con tombstones

Un registro con la misma clave y un **valor null** es un **tombstone**. La compactación lo retiene
lo suficiente para que los consumidores observen el borrado, y luego eventualmente lo elimina.
`delete.retention.ms` es también el límite dentro del cual un consumidor que arranca en el offset
cero debe completar su escaneo para tener garantizado un snapshot válido del estado final, como
explica la
[referencia de configuración del broker de Kafka](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_log.cleaner.delete.retention.ms).
Configura esa ventana a partir del tiempo de replay del peor caso medido; no asumas que el defecto
es automáticamente seguro para un topic grande.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-tombstone-flow.svg' | relative_url }}"
       alt="Un administrador de configuración publica un valor null como tombstone de Kafka, y cada pod lo consume y elimina la clave correspondiente de su caché local">
  <figcaption>El tombstone se difunde como cualquier otro registro; cada pod interpreta su valor null como una instrucción de eliminar la clave.</figcaption>
</figure>

El borrado físico es apropiado solo cuando la aplicación debe olvidar de verdad la configuración.
Si una configuración inactiva debe seguir disponible para una auditoría, datos antiguos o una
reactivación posterior, publica un registro normal con `active: false` o `deactivatedAt` y
mantenlo en la caché. Si el número de entradas es pequeño, retener toda la configuración
localmente puede ser más simple. Un topic compactado conserva el último valor por clave, no todas
las revisiones por siempre; usa claves versionadas o un topic de historial separado cuando se
requiere historial completo.

El ejemplo usa un `ConcurrentHashMap` para `LocalConfigCache`. Spring Kafka arranca con un hilo de
consumo por defecto, pero la concurrencia del listener configurada puede actualizar la misma caché
desde varios hilos. La anotación `@ConfigConsumer` del listener lo conecta con la compuerta de
readiness que se describe a continuación.

A este punto cada pod puede construir el estado local correcto. Aun así no debe usar ese estado
hasta que el replay haya terminado.

## No sirvas tráfico hasta que te hayas puesto al día

> No recibas tráfico, no ejecutes jobs programados ni hagas otro trabajo externo hasta que la
> configuración haya sido consumida.

Esta es la parte fácil de saltarse y cara de saltarse. Un pod que reporta "listo" en el momento en
que le asignan particiones está listo solo de nombre — puede haber reprocesado tres registros de
tres mil. Las peticiones golpean una caché casi vacía; un job programado corre con defectos
desactualizados; nadie se entera hasta que alguien pregunta por qué el pod 14 se comportó distinto
durante dos minutos después de un deploy.

El ejemplo empaqueta esta preocupación como un pequeño módulo `readiness-gate`. Cuando Kafka
asigna particiones, la compuerta captura sus end offsets actuales como objetivo de arranque. Cada
registro procesado exitosamente avanza la posición rastreada de su partición. El readiness se
abre solo después de que cada partición alcance su objetivo capturado y no quede ningún error de
procesamiento. Los topics vacíos también funcionan: sus posiciones iniciales ya igualan sus end
offsets.

El objetivo es un snapshot fijo. Los registros publicados después de la asignación de particiones
no lo extienden, así que un topic actualizado continuamente no puede mantener al pod en arranque
para siempre. Una vez alcanzado el objetivo capturado, los registros posteriores continúan por la
ruta normal de actualización en vivo y siguen sujetos al trade-off de consistencia eventual
descrito abajo.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-readiness-gate.svg' | relative_url }}"
       alt="Cuatro etapas de la compuerta de readiness: registrar el consumidor de configuración, capturar objetivos fijos por partición, reprocesar registros y avanzar posiciones solo tras un éxito, y luego abrir el readiness cuando se alcanzan todos los objetivos">
  <figcaption>La compuerta arranca cerrada, rastrea el replay exitoso contra objetivos fijos y se abre solo cuando cada partición asignada se ha puesto al día.</figcaption>
</figure>

El flujo tiene cuatro responsabilidades. Primero, una anotación de marcador identifica el método
`@KafkaListener` cuyos argumentos `ConsumerRecord` rastrea la compuerta de readiness:

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface ConfigConsumer {
    String value() default "";
}
```

Segundo, el tracker registra los end offsets objetivo capturados en la asignación y el siguiente
offset después de cada registro procesado exitosamente:

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

`ConsumerReplayProgress` posee las particiones asignadas, mientras que un pequeño
`PartitionReplayProgress` posee la posición actual, el objetivo fijo y el error de una partición.
Mantener esas responsabilidades separadas hace explícita la regla de readiness: cada partición
asignada debe alcanzar su propio objetivo, y una falla solo se limpia con un registro exitoso de
esa misma partición.

Un aspecto `@Around` reporta al tracker automáticamente cada `ConsumerRecord` procesado
exitosamente —
el método del listener nunca lo llama directamente, razón por la cual `ConfigTopicListener.onMessage` de
arriba no tiene ningún código relacionado con readiness, solo la anotación `@ConfigConsumer("config-topic")`.
Un registrador separado pre-registra cada método `@ConfigConsumer` al arrancar, antes de que llegue
el primer mensaje. Un `ConsumerAwareRebalanceListener` provee las asignaciones y sus end offsets
capturados. Eso mantiene el readiness en `DOWN` desde el arranque hasta que el listener haya
procesado hasta cada objetivo, y recalcula el objetivo tras un rebalanceo.

Tercero, expón la compuerta mediante un `HealthIndicator` normal en el grupo de salud de
**readiness** de Spring Boot. Esto compone el estado de la caché con el estado de readiness del
propio Boot y le da a la plataforma de despliegue un endpoint estable para sondear. También evita
competir con los eventos de disponibilidad de aplicación de Boot durante el arranque:

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

`/actuator/health/readiness` ahora reporta `UP` solo después de que cada partición asignada
alcance su objetivo de arranque capturado. Configura la plataforma de despliegue para retener el
tráfico hasta que ese endpoint retorne éxito.

El servicio de Docker Compose del ejemplo usa el mismo endpoint como su `healthcheck`, así que
Docker marca la aplicación como sana solo cuando el replay termina. Esto refleja el check de
disponibilidad de una plataforma de despliegue; el estado de salud de Compose en sí no controla el
enrutamiento del tráfico.

Cuarto, proteger jobs programados (o cualquier otro método de bean) de la misma manera, sin
repetir el check `if (!tracker.isFullyConsumed()) return;` en cada punto de llamada: una segunda
anotación, `@ReadinessGated`, más su propio pequeño aspecto que se salta la llamada por completo
hasta que la compuerta se abre — esto es con lo que `CacheSnapshotJob.logSnapshot` de arriba está
realmente anotado:

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

La misma forma que el aspecto `@ConfigConsumer` de antes, apuntado en la dirección contraria: ese
*reporta* actividad al tracker, este la *lee* y decide si deja pasar la llamada. Solo tiene sentido
en métodos `void` — una llamada saltada retorna `null` — que es exactamente lo que es un job
`@Scheduled`.

### Aplicando la compuerta de readiness

La aplicación debe bloquear toda interacción con el mundo exterior que dependa de esta
configuración; de lo contrario, puede actuar sobre una caché vacía o desactualizada. El ejemplo
implementa dos compuertas de este tipo, pero el mismo principio aplica más ampliamente.

Para tráfico HTTP, el `ConfigConsumptionHealthIndicator` mantiene el endpoint de readiness en
`DOWN` hasta que el replay esté completo. Los controllers no necesitan repetir
`tracker.isFullyConsumed()` en cada endpoint cuando la plataforma de despliegue usa ese endpoint
para retener el tráfico. Por ejemplo, en Kubernetes, usa un `readinessProbe` para el enrutamiento
y dale a un `startupProbe` tiempo suficiente para un replay inicial grande:

```java
@GetMapping("/api/cache")
public ResponseEntity<Map<String, CacheEntry>> all() {
    return ResponseEntity.ok(cache.snapshot());
}
```

Para un job programado, `@ReadinessGated` evita la invocación hasta que el mismo tracker esté
listo:

```java
@ReadinessGated
@Scheduled(fixedDelayString = "${app.cache-snapshot-job.interval}")
public void logSnapshot() {
    log.info("Local cache holds {} entries", cache.size());
}
```

Otras interacciones externas necesitan una compuerta equivalente. Por ejemplo, un listener de cola
que dependa de esta configuración no debería empezar a procesar hasta que la caché esté lista;
resuélvelo a nivel de listener/contenedor o con una estrategia de acknowledgment que no acuse de
recibo ni pierda mensajes mientras la compuerta está cerrada. Este ejemplo provee compuertas solo
para tráfico HTTP y jobs programados, pero la misma señal de readiness puede impulsar protección
equivalente para consumidores de colas, llamadas salientes o cualquier otro trabajo dependiente de
la configuración.

## Dónde duele este patrón

El camino feliz es atractivo: reprocesar una vez y luego servir lecturas locales. El costo
operativo aparece en las fronteras — arranque, lag, retención y fallas. Estas son las decisiones
que haría explícitas antes de elegir el patrón.

### Cada reinicio paga el costo del replay

Un grupo nuevo no tiene offsets, así que cada pod reconstruye desde el principio. El costo por lo
tanto crece con los registros todavía presentes en el log compactado — no simplemente con el
número de claves actuales, porque la compactación es asíncrona y los segmentos viejos pueden
permanecer un tiempo. Mide el tiempo de replay con datos parecidos a producción y dale al
`startupProbe` presupuesto suficiente. Kafka ya obtiene los registros en lotes, así que afina
`max.poll.records` y mantén barato el trabajo por registro. Para replays más grandes, cambia el
listener a modo batch y aplica cada lista retornada en una sola invocación; el aspecto de tracking
del ejemplo soporta tanto argumentos individuales `ConsumerRecord` como lotes iterables. Agrega
concurrencia al listener solo cuando el topic tenga suficientes particiones para aprovecharla.
Tres particiones permiten que a lo sumo tres hilos de consumo en un pod avancen en paralelo.
El replay del peor caso también debe caber dentro de la ventana de retención de tombstones del
topic, o un escaneo desde el offset cero no tiene garantía de reconstruir un snapshot válido.

Los objetivos capturados no se mueven cuando los productores agregan registros nuevos durante el
replay, así que las escrituras continuas no hacen ilimitado el arranque. El log existente es lo
que determina el tiempo de arranque. Si ese log es lo bastante grande para volver el readiness
lento o impredecible, el topic probablemente está fuera del caso de uso de configuración de bajo
volumen previsto para este patrón.

### Los grupos únicos dejan metadatos temporales

Cada pod genera un grupo de consumo nuevo. Después de que el pod desaparece, sus offsets
confirmados siguen visibles hasta que Kafka elimina los metadatos de grupos inactivos según la
configuración de retención del broker. Esto suele ser desorden operativo, no una carga activa en
crecimiento constante, pero afecta los dashboards y cualquier automatización que asuma que cada
grupo listado está activo. Usa un prefijo identificable, monitorea la
[política de retención de offsets](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_offsets.retention.minutes)
del broker y filtra los grupos inactivos en las herramientas.

### La configuración grande no pertenece a cada pod

Este patrón es una buena opción para un conjunto de configuración pequeño y leído con frecuencia.
Si la configuración es grande, mantener todo el dataset en memoria local suele ser una mala idea.
Cada pod necesita heap suficiente para su propia copia, y agregar pods multiplica ese costo de
memoria. Mantén la configuración grande en un almacenamiento compartido, o materializa solo el
subconjunto pequeño que cada servicio realmente necesita.

### La consistencia eventual es parte del contrato

Cada pod consume las actualizaciones de forma independiente, así que dos pods pueden devolver
brevemente valores distintos. Un consumidor lento, un rebalanceo, un reintento o una caída de
Kafka pueden extender esa brecha. Esto es aceptable para feature flags, pistas de enrutamiento y
otra configuración que tolera desactualización breve; es una mala opción para decisiones de
autorización, inventario, saldos o cualquier regla que deba cambiar en todas partes en el mismo
instante. Define el lag tolerado, monitórealo y haz explícito el comportamiento con datos
desactualizados a los llamadores antes de elegir este diseño.

Estos costos no hacen que el patrón esté mal. Definen su rango útil: datos de referencia
compactos, reprocesables y eventualmente consistentes con una ruta de lectura muy caliente y un
equipo que ya se siente cómodo operando Kafka.

<aside class="post-lab-cta">
  <span class="post-lab-cta-label">Laboratorio interactivo de producción</span>
  <h2>¿Puedes mantener viva esta arquitectura?</h2>
  <p>Diagnostica cuatro fallas que involucran grupos de consumo, replay de arranque, readiness y tombstones.
  Toma unos cinco minutos.</p>
  <a href="{{ '/labs/kafka-local-cache/' | relative_url }}" class="btn-primary">
    Iniciar el laboratorio de incidentes <i class="fas fa-arrow-right"></i>
  </a>
</aside>

## Código

El código de este artículo está disponible en
**[github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article](https://github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article)**.
El README del repositorio contiene las instrucciones de configuración y ejecución, incluyendo cómo
inspeccionar los grupos de consumo, observar la propagación de tombstones y escalar la aplicación
localmente.

---

## Hablemos

Si estás corriendo —o has corrido— algo similar, me gustaría saber dónde te quedaron los
trade-offs. Los enlaces de contacto están en el pie de página.
