---
layout: post
lang: pt-BR
lang_key: local-cache-via-kafka
permalink: /pt-BR/2026/08/08/local-cache-via-kafka/
title: "O Kafka Pode Substituir o Redis na Sincronização de Cache? Uma Resposta de Produção"
date: 2026-08-08
tags: [kafka, spring-boot, java, distributed-systems]
excerpt: "Uma thread no Reddit perguntou se o Kafka pode substituir o Redis para difundir atualizações de cache a 25 pods Spring Boot. Este é um padrão que vi se sustentar em produção por anos — um tópico compactado, um consumer group por pod e um gate de readiness — com um exemplo executável em docker-compose."
description: "O Kafka pode substituir o Redis na sincronização de cache entre pods Spring Boot? Padrão de produção: tópico compactado, consumer group por pod e readiness."
tech_icon: "fas fa-stream"
faq:
  - question: "O Kafka pode substituir o Redis na sincronização de cache entre pods?"
    answer: "Sim, para a tarefa específica de **difundir** estado para todas as instâncias — é uma ferramenta diferente fazendo um trabalho relacionado, não um substituto direto. O Redis dá a todo pod uma única visão compartilhada de cache, enquanto o Kafka dá a cada pod a sua **própria** cópia eventualmente consistente, construída reproduzindo um tópico compactado. Use este padrão quando a latência de leitura local importa e uma desatualização de curta duração após uma atualização é aceitável."
  - question: "Com N pods, todo pod recebe todas as mensagens do Kafka ou o Kafka divide as mensagens entre eles?"
    answer: "Depende inteiramente do **consumer group**, não do Kafka em si. Pods que compartilham um consumer group têm as partições divididas entre eles (com balanceamento de carga) — cada mensagem vai para exatamente um pod. Dê a cada pod o seu **próprio** consumer group, distinto, e cada grupo recebe o tópico completo de forma independente, então todo pod vê todas as mensagens. Esse é o padrão de broadcast que este artigo cobre."
  - question: "Como dar a cada pod o seu próprio consumer group no Kafka?"
    answer: "Combine um prefixo controlado por você com o valor por instância `${random.uuid}` do Spring: `group-id: ${CONSUMER_GROUP_PREFIX}-${random.uuid}`. Cada instância da aplicação recebe um grupo único, então todo pod consome o tópico completo de forma independente."
  - question: "Como excluir uma chave quando o tópico do Kafka é compactado?"
    answer: "Publique um **tombstone**: um registro com a mesma chave e um valor **nulo**. Os consumers que o encontram removem a chave do cache em vez de cachear null. O Kafka eventualmente remove tanto o valor substituído quanto o tombstone; dimensione o `delete.retention.ms` para que um replay completo possa terminar dentro dessa janela, que a documentação do Kafka define como o limite para reconstruir um snapshot válido a partir do offset zero."
  - question: "Jobs agendados e tráfego devem esperar o consumo do Kafka ficar em dia?"
    answer: "Sim. Um pod que começa a servir requisições ou a rodar jobs agendados antes de ter reproduzido o tópico está trabalhando com um cache vazio ou parcial. Mantenha o readiness `DOWN` até o replay de inicialização terminar. O exemplo captura o end offset de cada partição quando ela é atribuída e só abre o readiness depois de toda posição processada atingir o seu alvo."
  - question: "Atualizações contínuas podem deixar um pod novo preso no startup para sempre?"
    answer: "Não. O gate de readiness captura um end offset fixo para cada partição quando o Kafka a atribui. Registros anexados depois desse snapshot não movem o alvo de inicialização; o pod os processa normalmente como atualizações eventualmente consistentes. O startup ainda pode demorar quando o log compactado existente é grande, o que é uma das razões pelas quais este padrão é melhor para tópicos de upsert pequenos e de baixo volume, como feature flags e configuração de serviços."
---

# O Kafka Pode Substituir o Redis na Sincronização de Cache? Uma Resposta de Produção

Recentemente me deparei com uma pergunta no r/apachekafka que captura um problema comum de
sincronização de cache:
**[O Kafka Pode Substituir o Redis na Sincronização de Cache Entre Múltiplos Pods Spring Boot?](https://www.reddit.com/r/apachekafka/comments/1vhv9nn/can_kafka_replace_redis_for_cache_synchronization/)**

<blockquote class="post-question">
  <span class="post-question-label">A pergunta original, parafraseada</span>
  <p>Spring Boot no GCP, ~25 pods, o Redis hoje cuida da sincronização de cache. Considerando o Kafka
  em vez disso: publicar um evento quando uma entrada de cache muda, cada pod o consome e atualiza o
  seu próprio cache local. O Kafka é um bom encaixe aqui? Com 25 pods, todo pod recebe a atualização,
  ou o Kafka a entrega a apenas um consumer? Cada pod precisa do seu próprio consumer group? Alguém
  já rodou isso de verdade — quais são os prós e contras?</p>
</blockquote>

Eu tenho experiência resolvendo essa classe de problema. A abordagem descrita aqui — um tópico Kafka
compactado usado para materializar um cache local em cada pod — é um padrão comum e roda em sistemas
de produção há anos. Ele não é um substituto universal para o Redis, mas é uma opção prática quando
os seus trade-offs de consistência e operação se encaixam na carga de trabalho. Este artigo explica o
padrão, os detalhes que importam na prática e um pequeno exemplo executável.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-flow.svg' | relative_url }}"
       alt="Um producer de configuração publica em um tópico Kafka compactado, que três consumer groups reproduzem em caches locais separados no Pod A, Pod B e Pod C">
  <figcaption>Cada pod usa um consumer group separado, recebe o tópico completo e serve as leituras do seu próprio cache local.</figcaption>
</figure>

## O Problema: Configuração Compartilhada em um Caminho de Leitura Rápido

Suponha que a aplicação tenha configuração ou dados de referência de que toda instância precisa com
frequência: regras de feature, configurações de roteamento, configurações de tenant ou dados
similares. Precisa ser rápido de recuperar, mas também precisa mudar sem fazer redeploy de todos os
pods.

Um cache Redis compartilhado é uma solução natural. Todo pod lê o mesmo valor gerenciado
centralmente, então depois de uma atualização há uma única visão corrente a consultar. O trade-off é
que cada leitura sai do processo e depende do serviço de cache estar disponível e responsivo.
Dependendo da estratégia de cache escolhida, um miss no Redis também pode causar uma busca adicional:
com cache-aside, por exemplo, a aplicação lê a fonte da verdade e só então popula o Redis, antes de a
próxima requisição poder usar o cache.

O Kafka adota uma abordagem diferente. Uma atualização é anexada a um tópico compactado, e cada
instância reproduz esse tópico no próprio cache em memória. As leituras então são lookups em um mapa
local. As réplicas são eventualmente consistentes: quando um pod começa a processar trabalho, pode
ainda ter um valor mais antigo enquanto se atualiza — ou nenhum valor, se o consumo falhou. Mais
adiante, mostrarei como impedir que um pod faça trabalho real antes de ter consumido a configuração.
Em troca, o Kafka fornece um log durável para replay e recuperação, mantém o caminho de leitura
dentro do pod e pode suportar serialização explícita baseada em schema, como Avro, Protobuf ou JSON
Schema.

Nem o Kafka nem o Redis são imunes a falhas. Mas se o Kafka já é uma dependência, usá-lo para
distribuir essa configuração pode evitar adicionar o Redis como mais uma dependência de runtime e
mais um sistema para operar. Isso reduz o número de partes móveis e de modos de falha a considerar;
não faz as falhas do Kafka desaparecerem. É um trade que vale a pena apenas quando a consistência
eventual é aceitável para os dados.

O Kafka também pode desacoplar o serviço que publica a configuração dos serviços que a consomem.
Eles só precisam concordar com o contrato do registro e o seu schema; os consumers não precisam de
uma dependência direta de runtime com o producer. Com o Redis, ambos os lados normalmente precisam
concordar com o formato das chaves e o valor serializado — muitas vezes o mesmo DTO ou uma
representação compartilhada — e os consumers precisam saber onde lê-lo.

| Aspecto | Redis (cache compartilhado) | Kafka (tópico compactado → cache local) |
|---|---|---|
| Visão dos dados | Um cache gerenciado centralmente | Um cache materializado por instância |
| Consistência | Uma visão compartilhada de cache; mudanças na fonte ainda exigem invalidação correta | Consistência eventual entre réplicas locais |
| Caminho de leitura | Ida e volta pela rede; misses podem exigir busca na fonte da verdade | Lookup em mapa no próprio processo após o replay inicial |
| Recuperação / novas instâncias | Popular ou aquecer o cache | Reproduzir o tópico compactado |
| Histórico de registros | Não é inerente ao cache | Estado corrente reproduzível; a compactação remove valores substituídos, então não é um log de auditoria |
| Acoplamento de serviços | Formato chave/valor compartilhado e acesso ao Redis | Schema de registro compartilhado; sem dependência direta do producer |
| Custo operacional | Camada de cache compartilhada, mais o Kafka se também for necessário | Armazenamento e consumers do Kafka, e um cache por instância |

Este artigo se concentra em como construir o lado do Kafka com segurança: difundir toda atualização
para todas as instâncias, reconstruir o cache na inicialização e se recusar a fazer trabalho real até
essa reconstrução estar completa.

**Uma nota sobre o código**: o repositório é uma demonstração executável, não uma biblioteca pronta
para produção. Verifiquei o fluxo Docker dele de ponta a ponta: replay de inicialização, readiness,
atualizações ao vivo e remoção via tombstone. Antes de adotar o padrão, teste-o contra os seus
próprios cenários de volume, rebalance, serialização, retry e indisponibilidade.

<div class="post-tldr" markdown="1">
<p class="post-tldr-title">TL;DR</p>

- **Sim, com uma ressalva**: o Kafka substitui o Redis para *difundir* estado a todos os pods, não para
  ler de um único cache compartilhado. Cada pod recebe a sua própria cópia local, eventualmente consistente.
- **Todo pod precisa do seu próprio consumer group do Kafka.** Pods que compartilham um grupo dividem as
  partições (com balanceamento de carga); pods cada qual em seu próprio grupo recebem o tópico completo (broadcast).
- O tópico precisa estar **compactado**. Use mais de uma partição quando o replay de inicialização precisar
  de concorrência e torne o cache local **thread-safe** quando a concorrência do listener estiver habilitada.
- Mantenha o dataset **pequeno e de volume relativamente baixo**. Esse padrão serve para feature flags, regras
  de roteamento e configuração de serviços — não para um dataset de negócio grande ou de alta rotatividade.
- **Exclusões são tombstones**: um registro com valor nulo, não um tipo especial de mensagem de "delete".
- **Espere o replay de inicialização terminar antes de interagir com o mundo externo.**
  Não sirva endpoints, não rode jobs agendados, não processe mensagens de fila nem realize outro trabalho
  visível externamente a partir de um cache local parcial. Abra o readiness só depois de o replay estar completo.
- Grupos únicos deixam para trás metadados de offset inativos até a retenção configurada do Kafka removê-los.
  Espere desordem temporária nas ferramentas de consumer group e monitore as configurações relevantes do broker.
</div>

---

## Como o Fluxo Inteiro Funciona

Há duas fases: **reconstruir a réplica local** e depois **mantê-la atualizada**.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-local-cache-lifecycle.svg' | relative_url }}"
       alt="Ciclo de vida do cache local via Kafka em duas fases: o startup captura alvos fixos de partição e mantém o readiness fechado enquanto os registros são aplicados; o estado estacionário abre o readiness, serve leituras locais e continua aplicando atualizações posteriores">
  <figcaption>O startup tem uma linha de chegada fixa. Depois de toda partição atingi-la, o mesmo listener mantém o cache local do pod pronto atualizado.</figcaption>
</figure>

1. Um producer grava um upsert no tópico compactado. A chave do registro Kafka é a chave da
   configuração; o valor é a configuração mais recente. Um valor nulo é um tombstone que significa
   exclusão.
2. Um pod novo começa com um consumer group novo e `auto.offset.reset=earliest`, então o Kafka atribui
   todas as partições do tópico ao grupo desse pod e o replay começa a partir dos offsets mais antigos
   retidos.
3. Durante a atribuição, o gate de readiness lê dois números para cada partição: a posição corrente do
   consumer e o end offset da partição. Esse end offset se torna o **alvo fixo de inicialização**.
4. O listener aplica cada registro a um mapa local thread-safe. Só depois de o listener retornar com
   sucesso o aspecto de rastreamento avança a posição processada daquela partição. Uma falha do
   listener, portanto, não pode fazer o gate afirmar que o registro que falhou foi aplicado.
5. Quando toda partição atinge o alvo capturado, o readiness muda para `UP`. A plataforma de deploy
   pode então rotear requisições ao pod, e jobs travados por readiness podem rodar. As leituras usam o
   mapa local e não chamam o Kafka.
6. O mesmo consumer continua ativo após o startup. Novos registros atualizam ou removem entradas
   locais conforme chegam, então os pods convergem de forma independente e ficam eventualmente
   consistentes entre si.

O alvo fixo do passo 3 é importante. Se um producer grava enquanto o replay está rodando, o novo
registro não move a linha de chegada do startup para sempre. O consumer ainda o processa pelo caminho
normal do listener, mas o readiness é definido contra o snapshot capturado na atribuição. O que pode
tornar o startup lento é um log existente grande, não um fluxo posterior de atualizações de baixo
volume. É por isso que o padrão se destina a datasets de upsert pequenos e de baixa rotatividade, como
feature flags, regras de roteamento e configuração de serviços.

---

## Publique o Estado Corrente em um Tópico Compactado

Comece criando o tópico de configuração com `cleanup.policy=compact`. A compactação retém o registro
mais recente de cada chave, então um pod que começa mais tarde pode reproduzir o tópico desde o
começo e reconstruir a configuração corrente sem pedir a outro serviço que aqueça o seu cache.

Isso funciona melhor para um tópico de upsert pequeno e de volume relativamente baixo: feature flags,
regras de roteamento, configurações de tenant ou configuração similar. Não é um bom default para um
dataset grande ou de alta rotatividade que todo pod precisaria reproduzir e reter em memória.

Crie partições suficientes para permitir que um pod reproduza o tópico concorrentemente com várias
threads de consumer quando o tempo de startup importa. A concorrência útil é limitada pela contagem
de partições, e o cache local precisa ser thread-safe quando a concorrência do listener é configurada
acima de um. No exemplo, um serviço one-shot `kafka-topic-init` cria e semeia o tópico antes de a
aplicação começar.

O próximo requisito é garantir que todo pod receba esse estado.

## Dê a Cada Pod o Seu Próprio Consumer Group

Um consumer group do Kafka tem uma visão independente de um tópico: dentro do grupo, cada partição é
atribuída a um consumer. Portanto, pods que compartilham um grupo dividem o trabalho; pods em grupos
separados consomem cada qual o tópico completo.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-consumer-groups.svg' | relative_url }}"
       alt="Comparação entre um consumer group Kafka compartilhado, em que as partições são divididas entre os pods, e um grupo único por pod, em que todo pod recebe todas as partições">
  <figcaption>Um grupo compartilhado divide o estado. Um grupo único por pod dá a cada cache local o estado completo.</figcaption>
</figure>

Dê a cada pod um `group.id` único. Neste exemplo, um prefixo compartilhado identifica o deploy e o
`${random.uuid}` do Spring fornece o sufixo por instância:

```yaml
app:
  config-topic: ${CONFIG_TOPIC:local-cache-config}
  kafka:
    bootstrap-servers: ${KAFKA_BOOTSTRAP_SERVERS:localhost:9092}
    consumer-group: ${CONSUMER_GROUP_PREFIX:local-cache-demo}-${random.uuid}
```

Todo startup cria um grupo novo e precisa reconstruir o cache local. Por isso, defina
`auto.offset.reset` como `earliest` nas propriedades do consumer. `latest` deixaria um pod novo vazio
até a próxima atualização chegar.

```java
Map<String, Object> consumerProperties = Map.of(
        // other consumer properties...
        ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
```

Com o tópico e o comportamento de broadcast no lugar, cada pod pode agora materializar o mesmo estado
local.

## Materialize as Atualizações no Cache Local

Uma vez que o tópico contém o estado corrente e todo pod o recebe, o listener é deliberadamente
pequeno: colocar registros normais no cache local e remover uma chave para um tombstone.

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

Registros normais cobrem criações e atualizações. A exclusão precisa de uma convenção adicional.

## Exclua Configuração com Tombstones

Um registro com a mesma chave e um **valor nulo** é um **tombstone**. A compactação o retém por tempo
suficiente para os consumers observarem a exclusão e depois eventualmente o remove. O
`delete.retention.ms` também é o limite dentro do qual um consumer começando no offset zero precisa
completar o seu scan para ter garantia de um snapshot válido do estado final, como explica a
[referência de configuração do broker do Kafka](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_log.cleaner.delete.retention.ms).
Configure essa janela a partir do tempo de replay de pior caso medido; não assuma que o default é
automaticamente seguro para um tópico grande.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-tombstone-flow.svg' | relative_url }}"
       alt="Um administrador de configuração publica um valor nulo como um tombstone Kafka, e cada pod o consome e remove a chave correspondente do seu cache local">
  <figcaption>O tombstone é difundido como qualquer outro registro; cada pod interpreta o seu valor nulo como uma instrução para remover a chave.</figcaption>
</figure>

A exclusão física é apropriada apenas quando a aplicação deve de fato esquecer a configuração. Se uma
configuração inativa precisa continuar disponível para auditoria, dados antigos ou reativação
posterior, publique um registro normal com `active: false` ou `deactivatedAt` e mantenha-o no cache.
Se a contagem de entradas é pequena, reter toda configuração localmente pode ser mais simples. Um
tópico compactado mantém o valor mais recente por chave, não toda revisão para sempre; use chaves
versionadas ou um tópico separado de histórico quando o histórico completo for necessário.

O exemplo usa um `ConcurrentHashMap` para o `LocalConfigCache`. O Spring Kafka começa com uma thread
de consumer por default, mas a concorrência de listener configurada pode atualizar o mesmo cache a
partir de múltiplas threads. A anotação `@ConfigConsumer` no listener o conecta ao gate de readiness
descrito a seguir.

Neste ponto, todo pod pode construir o estado local correto. Ele ainda não pode usar esse estado até
o replay terminar.

## Não Sirva Tráfego Até Se Atualizar

> Não receba tráfego, não rode jobs agendados nem realize outro trabalho externo até a
> configuração ter sido consumida.

Essa é a parte fácil de pular e cara de pular. Um pod que se reporta "pronto" no instante em que as
partições lhe são atribuídas está pronto só no nome — pode ter reproduzido três registros de um total
de três mil. Requisições batem em um cache quase vazio; um job agendado roda com defaults
desatualizados; ninguém nota até alguém perguntar por que o pod 14 se comportou diferente por dois
minutos depois de um deploy.

O exemplo empacota essa preocupação em um pequeno módulo `readiness-gate`. Quando o Kafka atribui
partições, o gate captura os seus end offsets correntes como alvo de inicialização. Cada registro
processado com sucesso avança a posição rastreada da sua partição. O readiness só abre depois de toda
partição atingir o alvo capturado e nenhum erro de processamento permanecer. Tópicos vazios funcionam
também: as suas posições iniciais já são iguais aos seus end offsets.

O alvo é um snapshot fixo. Registros publicados após a atribuição de partição não o estendem, então
um tópico atualizado continuamente não pode manter o pod no startup para sempre. Uma vez que o alvo
capturado é atingido, registros posteriores seguem pelo caminho normal de atualização ao vivo e
permanecem sujeitos ao trade-off de consistência eventual descrito abaixo.

<figure class="post-figure">
  <img src="{{ '/assets/img/articles/kafka-readiness-gate.svg' | relative_url }}"
       alt="Quatro estágios do gate de readiness: registrar o consumer de configuração, capturar alvos fixos de partição, reproduzir os registros e avançar as posições só depois de sucesso, e então abrir o readiness quando todos os alvos forem alcançados">
  <figcaption>O gate começa fechado, acompanha o replay bem-sucedido contra alvos fixos e só abre quando toda partição atribuída se atualizou.</figcaption>
</figure>

O fluxo tem quatro responsabilidades. Primeiro, uma anotação marcadora identifica o método
`@KafkaListener` cujos argumentos `ConsumerRecord` o gate de readiness rastreia:

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface ConfigConsumer {
    String value() default "";
}
```

Segundo, o tracker registra os end offsets alvo capturados na atribuição e o próximo offset depois de
cada registro processado com sucesso:

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

O `ConsumerReplayProgress` guarda as partições atribuídas, enquanto um pequeno
`PartitionReplayProgress` guarda a posição corrente, o alvo fixo e o erro de uma partição. Manter
essas responsabilidades separadas torna a regra de readiness explícita: cada partição atribuída
precisa atingir o próprio alvo, e uma falha só é limpa por um registro bem-sucedido dessa mesma
partição.

Um aspecto `@Around` reporta ao tracker automaticamente todo `ConsumerRecord` processado com sucesso
— o próprio método do listener nunca o chama diretamente, e é por isso que o
`ConfigTopicListener.onMessage` acima não tem código algum relacionado a readiness, apenas a anotação
`@ConfigConsumer("config-topic")`.
Um registrador separado pré-registra todo método `@ConfigConsumer` no startup, antes da primeira
mensagem chegar. Um `ConsumerAwareRebalanceListener` fornece as atribuições e os seus end offsets
capturados. Isso mantém o readiness `DOWN` desde o startup até o listener ter processado até cada
alvo, e recalcula o alvo depois de um rebalance.

Terceiro, exponha o gate por meio de um `HealthIndicator` normal no grupo de saúde de **readiness**
do Spring Boot. Isso compõe o estado do cache com o estado de readiness do próprio Boot e dá à
plataforma de deploy um endpoint estável para consultar. Também evita competir com os eventos de
application-availability do Boot durante o startup:

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

O `/actuator/health/readiness` agora reporta `UP` só depois de cada partição atribuída atingir o seu
alvo de inicialização capturado. Configure a plataforma de deploy para reter tráfego até esse
endpoint retornar sucesso.

O serviço Docker Compose do exemplo usa o mesmo endpoint como seu `healthcheck`, então o Docker só
marca a aplicação como saudável depois de o replay terminar. Isso espelha a verificação de
disponibilidade de uma plataforma de deploy; o estado de saúde do Compose em si não controla o
roteamento de tráfego.

Quarto, travar jobs agendados (ou qualquer outro método de bean) da mesma maneira, sem repetir a
verificação `if (!tracker.isFullyConsumed()) return;` em cada ponto de chamada: uma segunda anotação,
`@ReadinessGated`, mais o seu próprio pequeno aspecto que ignora a chamada por completo até o gate
abrir — é com isso que o `CacheSnapshotJob.logSnapshot` acima está de fato anotado:

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

Mesma forma do aspecto `@ConfigConsumer` de antes, apontado na direção oposta: aquele *reporta*
atividade ao tracker, este *lê* e decide se deixa a chamada passar. Só faz sentido em métodos `void`
— uma chamada pulada retorna `null` — que é exatamente o que um job `@Scheduled` é.

### Aplicando o Gate de Readiness

A aplicação precisa bloquear toda interação com o mundo externo que dependa dessa configuração; caso
contrário, pode agir com um cache vazio ou desatualizado. O exemplo implementa dois desses gates, mas
o mesmo princípio se aplica mais amplamente.

Para tráfego HTTP, o `ConfigConsumptionHealthIndicator` mantém o endpoint de readiness `DOWN` até o
replay terminar. Os controllers não precisam repetir `tracker.isFullyConsumed()` em cada endpoint
quando a plataforma de deploy usa esse endpoint para reter tráfego. Por exemplo, no Kubernetes, use
um `readinessProbe` para roteamento e dê a um `startupProbe` tempo suficiente para um replay inicial
grande:

```java
@GetMapping("/api/cache")
public ResponseEntity<Map<String, CacheEntry>> all() {
    return ResponseEntity.ok(cache.snapshot());
}
```

Para um job agendado, o `@ReadinessGated` impede a invocação até o mesmo tracker estar pronto:

```java
@ReadinessGated
@Scheduled(fixedDelayString = "${app.cache-snapshot-job.interval}")
public void logSnapshot() {
    log.info("Local cache holds {} entries", cache.size());
}
```

Outras interações externas precisam de um gate equivalente. Por exemplo, um listener de fila que
dependa dessa configuração não deve começar a processar até o cache estar pronto; providencie isso no
nível do listener/container ou com uma estratégia de acknowledgement que não reconheça nem perca
mensagens enquanto o gate está fechado. Este exemplo fornece gates para tráfego HTTP e jobs agendados
apenas, mas o mesmo sinal de readiness pode gerar proteção equivalente para consumers de fila,
chamadas de saída ou qualquer outro trabalho dependente de configuração.

## Onde Esse Padrão Aperta

O caminho feliz é atraente: reproduzir uma vez e depois servir leituras locais. O custo operacional
aparece nas bordas — startup, lag, retenção e falha. Essas são as decisões que eu tornaria explícitas
antes de escolher o padrão.

### Todo Restart Paga o Custo do Replay

Um grupo novo não tem offsets, então todo pod se reconstrói desde o começo. O custo, portanto, cresce
com os registros ainda presentes no log compactado — não simplesmente com o número de chaves
correntes, porque a compactação é assíncrona e segmentos antigos podem permanecer por um tempo. Meça
o tempo de replay com dados parecidos com os de produção e dê ao `startupProbe` orçamento
suficiente. O Kafka já busca registros em lotes, então ajuste o `max.poll.records` e mantenha o
trabalho por registro barato. Para replays maiores, mude o listener para o modo em lote e aplique cada
lista retornada em uma única invocação; o aspecto de rastreamento do exemplo suporta tanto argumentos
individuais de `ConsumerRecord` quanto lotes iteráveis. Adicione concorrência ao listener apenas
quando o tópico tiver partições suficientes para aproveitá-la. Três partições permitem no máximo três
threads de consumer em um pod progredindo em paralelo.
O replay de pior caso também precisa caber dentro da janela de retenção de tombstones do tópico, ou
um scan a partir do offset zero não tem garantia de reconstruir um snapshot válido.

Os alvos capturados não se movem quando producers anexam novos registros durante o replay, então
escritas contínuas não tornam o startup ilimitado. O log existente é o que determina o tempo de
startup. Se esse log é grande o suficiente para tornar o readiness lento ou imprevisível, o tópico
provavelmente está fora do caso de uso de configuração de baixo volume a que o padrão se destina.

### Grupos Únicos Deixam Metadados Temporários

Cada pod gera um consumer group novo. Depois que o pod desaparece, os offsets confirmados dele
permanecem visíveis até o Kafka remover os metadados do grupo inativo conforme as configurações de
retenção do broker. Isso normalmente é desordem operacional, não uma carga viva sempre crescente,
mas afeta dashboards e qualquer automação que assuma que todo grupo listado está ativo. Use um prefixo
identificável, monitore a
[política de retenção de offsets](https://kafka.apache.org/42/configuration/broker-configs/#brokerconfigs_offsets.retention.minutes)
do broker e filtre grupos inativos nas ferramentas.

### Configuração Grande Não Pertence a Todo Pod

Esse padrão é um bom encaixe para um conjunto de configuração pequeno e lido com frequência. Se a
configuração é grande, manter o dataset inteiro em memória local costuma ser uma má ideia. Todo pod
precisa de heap suficiente para a própria cópia, e adicionar pods multiplica esse custo de memória.
Mantenha configuração grande em um armazenamento compartilhado, ou materialize apenas o pequeno
subconjunto que cada serviço realmente precisa.

### Consistência Eventual Faz Parte do Contrato

Cada pod consome atualizações de forma independente, então dois pods podem retornar valores
diferentes por breves instantes. Um consumer lento, um rebalance, um retry ou uma indisponibilidade
do Kafka podem estender esse intervalo. Isso é aceitável para feature flags, dicas de roteamento e
outras configurações que toleram desatualização de curta duração; é um encaixe ruim para decisões de
autorização, estoque, saldos ou qualquer regra que precise mudar em todos os lugares no mesmo
instante. Defina o lag tolerado, monitore-o e torne o comportamento com dados desatualizados
explícito para os chamadores antes de escolher este design.

Esses custos não tornam o padrão errado. Eles definem a sua faixa útil: dados de referência compactos,
reproduzíveis e eventualmente consistentes, com um caminho de leitura muito quente e uma equipe já
confortável em operar Kafka.

<aside class="post-lab-cta">
  <span class="post-lab-cta-label">Laboratório de produção interativo</span>
  <h2>Você consegue manter essa arquitetura de pé?</h2>
  <p>Diagnostique quatro falhas envolvendo consumer groups, replay de inicialização, readiness e tombstones.
  Leva cerca de cinco minutos.</p>
  <a href="{{ '/labs/kafka-local-cache/' | relative_url }}" class="btn-primary">
    Iniciar o laboratório de incidentes <i class="fas fa-arrow-right"></i>
  </a>
</aside>

## Código

O código deste artigo está disponível em
**[github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article](https://github.com/javaAndScriptDeveloper/kafka-backed-local-read-replica-article)**.
O README do repositório contém as instruções de configuração e execução, incluindo como inspecionar
consumer groups, observar a propagação de tombstones e escalar a aplicação localmente.

---

## Vamos Conversar

Se você está rodando — ou já rodou — algo parecido, eu gostaria de saber onde os trade-offs deram
certo para você. Os links de contato estão no rodapé.
