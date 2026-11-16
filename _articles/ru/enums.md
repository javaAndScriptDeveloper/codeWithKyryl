---
layout: post
lang: ru
lang_key: enums
permalink: /ru/2026/06/29/enums/
title: "Хранение enum в базе данных: @Enumerated, enum-типы Postgres и lookup-таблицы"
date: 2026-06-29
tags: [hibernate, postgres, spring-boot, java]
excerpt: "Как хранить enum с JPA: @Enumerated ORDINAL vs STRING, почему ординал — мина замедленного действия, маппинг настоящего enum-типа Postgres, AttributeConverter и когда lookup-таблица действительно оправдывает join."
description: "Хранение enum в PostgreSQL с Hibernate: @Enumerated ORDINAL vs STRING, enum-типы Postgres, AttributeConverter, lookup-таблицы — компромиссы каждого варианта."
tech_icon: "fas fa-database"
faq:
  - question: "Что использовать: @Enumerated ORDINAL или STRING?"
    answer: "Используйте **STRING**. `@Enumerated(ORDINAL)` хранит позицию константы (0, 1, 2…), поэтому вставка новой константы в любое место, кроме конца, молча меняет смысл всех существующих строк. `@Enumerated(STRING)` хранит имя константы ('PAID'): оно говорит само за себя, читается прямо в SQL и не боится перестановок. Несколько лишних байтов — ничтожная цена за такую надёжность."
  - question: "Что сломается, если добавить значение enum в середину при ORDINAL?"
    answer: "Все строки, относящиеся к константам *после* вставленной, начнут декодироваться в неверное значение. Если `SHIPPED` имел ординал 2 и перед ним вставили `PACKED`, `SHIPPED` станет 3 — но все существующие строки всё ещё хранят число 2, которое теперь читается как `PACKED`. База не менялась, изменилась её интерпретация. Защита — юнит-тест, фиксирующий `ordinal()` каждой константы."
  - question: "Как хранить enum как enum-тип Postgres?"
    answer: "Создайте тип через `CREATE TYPE order_status AS ENUM ('PENDING', 'PAID', …)`, сделайте колонку этого типа и замапьте поле в Hibernate через `@Enumerated(EnumType.STRING)`. Добавьте `stringtype=unspecified` в JDBC URL, чтобы драйвер отправлял значение как `unknown` и Postgres мог привести строку к enum. После этого база отклоняет любое значение вне enum."
  - question: "Как переименовать константу enum, не сломав существующие строки?"
    answer: "Отвяжите хранимое значение от Java-идентификатора. С JPA `AttributeConverter` в базу пишется стабильный код ('PAID'), а не имя константы, поэтому переименование `PENDING` в `AWAITING_PAYMENT` затрагивает только код: без миграции и без осиротевших строк. Поэтому lookup-таблица ради одних лишь переименований почти никогда не нужна."
  - question: "Когда вместо @Enumerated стоит использовать lookup-таблицу?"
    answer: "Когда значения несут редактируемые бизнес-данные, а не только идентичность (название для пользователей, порядок сортировки, feature flag), либо когда добавлять и менять значения в рантайме должны не разработчики. Если enum — фиксированный набор состояний на уровне кода, lookup-таблица в основном добавляет join и лишний уровень косвенности ради гибкости, которая никогда не понадобится."
---

# Хранение enum в базе данных: @Enumerated, enum-типы Postgres и lookup-таблицы

Почти в каждой доменной модели есть поле, которое может принимать лишь несколько значений.
Заказ — `PENDING`, `PAID`, `SHIPPED`, `DELIVERED` или `CANCELLED`. Платёж — авторизован или
захвачен. Подписка — на одном из четырёх тарифов. В Java рука сама тянется к `enum`.
Интересный вопрос — что происходит на границе: **как этот конечный набор значений реально
живёт в базе данных** и во что обойдётся каждый вариант полгода спустя, когда набор изменится.

Статья пройдёт по всем распространённым способам хранения enum с Hibernate в том порядке, в
каком их реально встречаешь: два режима `@Enumerated`, настоящий enum-тип Postgres,
`AttributeConverter` и, наконец, lookup-таблица, где enum становится отдельной таблицей.
На протяжении всей статьи я развиваю один пример, статус заказа, а в конце покажу, какой
вариант выбираю сам.

Стек: **Java, Spring Boot, Hibernate, PostgreSQL**.

<div class="post-tldr" markdown="1">
<p class="post-tldr-title">TL;DR</p>

- `@Enumerated(ORDINAL)` хранит **порядковый номер** константы — компактно, но вставка значения в середину молча портит все последующие строки. Если без него никак, **ординалы закрепляются юнит-тестом**.
- `@Enumerated(STRING)` хранит **имя константы** — самодокументируемо, удобно при отладке, не боится перестановок. Это разумный дефолт.
- Не ограничивайтесь голым `varchar`: настоящий **enum-тип Postgres** заставит саму базу отклонять недопустимые значения.
- **`AttributeConverter`** пишет в базу стабильный код, отвязанный от Java-имени, поэтому **переименования перестают быть проблемой базы данных**.
- **Lookup-таблица** оправдана, только когда значения несут редактируемые бизнес-данные, — но не как обходной путь для переименований.
</div>

---

## Сценарий

Строим управление заказами. Заказ проходит фиксированный жизненный цикл:

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> PAID
    PENDING --> CANCELLED
    PAID --> SHIPPED
    SHIPPED --> DELIVERED
    PAID --> CANCELLED
```

В Java это очевидный enum:

```java
public enum OrderStatus {
    PENDING,
    PAID,
    SHIPPED,
    DELIVERED,
    CANCELLED
}
```

У сущности заказа есть поле `status`. Остаётся один вопрос: как Hibernate замапит его на
колонку. Выбор всего одной аннотации имеет последствия, которые переживут код, написанный
сегодня.

---

## Часть 1 — `@Enumerated(ORDINAL)`: хранение числом

Дефолт JPA для enum — `ORDINAL`. Каждая константа хранится как позиция в объявлении:
`PENDING` → 0, `PAID` → 1, `SHIPPED` → 2 и так далее.

```java
@Entity
@Table(name = "orders_ordinal")
public class OrderOrdinal {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Enumerated(EnumType.ORDINAL)   // this is also the default if you omit @Enumerated
    @Column(nullable = false)
    private OrderStatus status;
}
```

```sql
CREATE TABLE orders_ordinal (
    id     UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
    status SMALLINT NOT NULL
);
```

Сохраним заказ со статусом `PAID`, и в колонке окажется `1`. Компактно, и на бумаге всё выглядит прилично.

### ❌ Ловушка: вставка значения в середину

Ординал хранится не как метка — он хранится как *позиция*, и позиция определяется порядком
в исходном коде. В тот день, когда кто-то добавит шаг упаковки между оплаченным и отгруженным:

```java
public enum OrderStatus {
    PENDING,
    PAID,
    PACKED,      // <-- inserted here
    SHIPPED,
    DELIVERED,
    CANCELLED
}
```

…каждая константа после `PAID` сдвигается на единицу:

| Константа | Ординал до | Ординал после |
|---|---|---|
| `PENDING`   | 0 | 0 |
| `PAID`      | 1 | 1 |
| `PACKED`    | — | **2** |
| `SHIPPED`   | 2 | **3** |
| `DELIVERED` | 3 | **4** |
| `CANCELLED` | 4 | **5** |

В базе не изменилось ничего. Каждый существующий заказ `SHIPPED` по-прежнему хранит число `2` —
но `2` теперь декодируется как `PACKED`. Отгруженные заказы молча становятся упакованными.
Доставленные — отгруженными. Ни ошибки, ни упавшей миграции, ни строчки в логе. Данные не
двигались — сдвинулась их интерпретация. Об этом вы узнаете, когда клиент спросит, почему
его доставленный заказ вдруг «упаковывается».

### Защита: закрепить ординалы

Если держать `ORDINAL` всё же приходится (legacy-схема, по-настоящему горячая огромная таблица,
где важна разница в байтах), зависимость от порядка нужно сделать *явной*: написать тест,
который падает, как только кто-то переставит константы enum:

```java
class OrdinalPinTest {

    @Test
    void ordinalsAreFrozen() {
        // If this test fails, you reordered OrderStatus. Existing ORDINAL-mapped rows now mean
        // something different. Revert the reorder, or append the new value at the end.
        assertThat(OrderStatus.PENDING.ordinal()).isZero();
        assertThat(OrderStatus.PAID.ordinal()).isEqualTo(1);
        assertThat(OrderStatus.SHIPPED.ordinal()).isEqualTo(2);
        assertThat(OrderStatus.DELIVERED.ordinal()).isEqualTo(3);
        assertThat(OrderStatus.CANCELLED.ordinal()).isEqualTo(4);
        assertThat(OrderStatus.values()).hasSize(5);
    }
}
```

Это чистый юнит-тест — без Spring-контекста, без базы. Он превращает невидимый баг с порчей
данных в красную сборку в момент, когда кто-то трогает enum. Новые значения добавлять
по-прежнему можно, но только в конец, где это безопасно. Это и есть негласное правило, на
котором держится `ORDINAL`, только теперь оно записано в коде.

---

## Часть 2 — `@Enumerated(STRING)`: хранение строкой

Для почти всех случаев решение сводится к одному слову:

```java
@Enumerated(EnumType.STRING)
@Column(nullable = false)
private OrderStatus status;
```

Теперь колонка хранит *имя* константы:

```sql
CREATE TABLE orders_string (
    id     UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR NOT NULL
);
```

Заказ со статусом `PAID` хранит буквальную строку `'PAID'`. Три вещи улучшаются сразу:

- **Перестановки безвредны.** Значение — само имя; позиции больше не важны. `PACKED` можно
  добавлять куда угодно.
- **Удобно отлаживать.** `SELECT * FROM orders_string WHERE status = 'PAID'` читается как
  обычная фраза. Не нужно ничего расшифровывать и сверяться с Java-кодом в уме.
- **Дампы и логи понятны без пояснений.** Строка в CSV-выгрузке осмысленна сама по себе.

Да, `'DELIVERED'` стоит больше байтов, чем `3`. Для подавляющего большинства таблиц эта разница —
шум, а индекс можно добавить в любой момент. Хранение имени — правильный дефолт: «компактность»
почти никогда не стоит тихой порчи данных.

### Единственная оставшаяся ловушка: переименования

`STRING` убирает ловушку порядка, но добавляет меньшую. Хранимое значение — это и есть
Java-идентификатор, поэтому переименование константы оставляет существующие строки сиротами:

```java
PENDING  →  AWAITING_PAYMENT
```

Каждая старая строка `'PENDING'` больше не соответствует ни одной константе, и Hibernate падает
при её чтении. Данные в базе и код тихо разошлись. Это лечится миграцией данных (`UPDATE … SET
status = 'AWAITING_PAYMENT' WHERE status = 'PENDING'`), и такой ответ вполне нормален. А в части 4
мы увидим способ, при котором переименование вообще перестаёт быть событием.

---

## Часть 3 — Хороший стиль: настоящий enum-тип Postgres

Оба варианта выше пишут в колонку, смысла которой база на самом деле не знает: это `smallint`
или `varchar`, в котором *просто так получилось*, что лежат значения enum. Postgres умеет лучше: у него есть
полноценные enum-типы:

```sql
CREATE TYPE order_status AS ENUM ('PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED');

CREATE TABLE orders_pgenum (
    id     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    status order_status NOT NULL
);
```

Теперь допустимые значения контролирует сама *база*. `INSERT … VALUES ('SHPPED')` — опечатка, плохая миграция,
чужой скрипт — падает на месте с `invalid input value for enum order_status`. С голым `varchar`
этот мусор попадает в таблицу и обнаруживается позже. Enum-тип — это одновременно документация и ограничение:
тип колонки буквально перечисляет допустимые значения.

Маппинг в Hibernate — тот же `@Enumerated(STRING)`, что и раньше: Hibernate привязывает имя
константы строкой, а Postgres кладёт её в enum:

```java
@Enumerated(EnumType.STRING)
@Column(nullable = false, columnDefinition = "order_status")
private OrderStatus status;
```

Нужна ровно одна дополнительная настройка. По умолчанию JDBC-драйвер PostgreSQL отправляет Java `String`
как тип `varchar`, а Postgres не приводит `varchar` → `order_status` неявно, поэтому получится
ошибка `column "status" is of type order_status but expression is of type character varying`.
Достаточно добавить `stringtype=unspecified` в JDBC URL: драйвер отправит значение как
`unknown`, и Postgres сможет привести его к enum:

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5434/mydatabase?stringtype=unspecified
```

(В Hibernate 6 есть ещё `@JdbcTypeCode(SqlTypes.NAMED_ENUM)` для прямой работы с именованным
enum-типом; связка `@Enumerated(STRING)` + `stringtype=unspecified` выше встречается чаще всего,
и я пользуюсь именно ей.)

**Единственный нюанс, о котором нужно знать:** `ALTER TYPE order_status ADD VALUE 'PACKED'`
только *добавляет в конец*. Значение можно добавить (начиная с PostgreSQL 12 — даже до или
после конкретного), но удалить или переставить существующие значения без пересоздания типа
нельзя. Это звучит как недостаток, пока не поймёшь, что перед нами *то же правило*, которое
закрепляет тест на ординалы: ничего не переставлять, только добавлять. Просто здесь гарантию
даёт база, а не юнит-тест. Ограничение и есть польза.

---

## Часть 4 — `AttributeConverter`: отвязываем имя от значения

Ловушка с переименованиями из части 2 возникла потому, что *хранимое значение*
и *Java-идентификатор* у нас — одна и та же строка. JPA `AttributeConverter` разрывает эту
связку: в базу пишется стабильный код, никак не связанный с именем константы.

Дадим каждой константе явный и постоянный код:

```java
public enum OrderStatus {

    PENDING("PND"),
    PAID("PAID"),
    SHIPPED("SHP"),
    DELIVERED("DLV"),
    CANCELLED("CNC");

    private final String code;

    OrderStatus(String code) {
        this.code = code;
    }

    public String getCode() {
        return code;
    }

    public static OrderStatus fromCode(String code) {
        return Arrays.stream(values())
                .filter(s -> s.code.equals(code))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown OrderStatus code: " + code));
    }
}
```

Затем конвертер, который отображает enum ↔ код:

```java
@Converter
public class OrderStatusConverter implements AttributeConverter<OrderStatus, String> {

    @Override
    public String convertToDatabaseColumn(OrderStatus status) {
        return status == null ? null : status.getCode();
    }

    @Override
    public OrderStatus convertToEntityAttribute(String code) {
        return code == null ? null : OrderStatus.fromCode(code);
    }
}
```

И подключим его на поле через `@Convert` вместо `@Enumerated`:

```java
@Convert(converter = OrderStatusConverter.class)
@Column(nullable = false)
private OrderStatus status;
```

Теперь база хранит `'PAID'` как *код*, а не как идентификатор. Переименование Java-константы
`PENDING` в `AWAITING_PAYMENT` не меняет хранимый код `'PND'`: переименование становится чистым
рефакторингом с нулевым влиянием на базу. Мы отвязали то, что знает база, от того, как мы
называем вещи в коде, — а это ровно то свойство, ради которого обычно берут lookup-таблицы.
Запомните это до следующей части.

---

## Часть 5 — Lookup-таблица

Последний подход вообще перестаёт считать статус enum-ом. Набор статусов живёт в собственной
таблице, а заказы ссылаются на строку внешним ключом:

```sql
CREATE TABLE order_statuses (
    id       INTEGER PRIMARY KEY,
    code     VARCHAR NOT NULL UNIQUE,
    label    VARCHAR NOT NULL,
    terminal BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO order_statuses (id, code, label, terminal) VALUES
    (1, 'PND',  'Pending',   FALSE),
    (2, 'PAID', 'Paid',      FALSE),
    (3, 'SHP',  'Shipped',   FALSE),
    (4, 'DLV',  'Delivered', TRUE),
    (5, 'CNC',  'Cancelled', TRUE);

CREATE TABLE orders_lookup (
    id        UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    status_id INTEGER NOT NULL REFERENCES order_statuses (id)
);
```

В JPA статус становится связью, а не перечисляемым значением:

```java
@Entity
@Table(name = "orders_lookup")
public class OrderLookup {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @ManyToOne(fetch = FetchType.EAGER, optional = false)
    @JoinColumn(name = "status_id", nullable = false)
    private OrderStatusDefinition status;
}
```

Чтобы узнать статус заказа — человекочитаемую метку и признак терминальности, — нужен **join**:

```sql
SELECT o.id, s.code, s.label
FROM   orders_lookup o
JOIN   order_statuses s ON s.id = o.status_id
WHERE  o.id = ?;
```

### ✅ Когда это оправдано

Lookup-таблица даёт одно реальное преимущество: набор значений и метаданные при каждом из них
живут в **данных**, а не в **коде**. Это по-настоящему ценно, когда:

- **Каждое значение несёт редактируемые бизнес-данные** — отображаемую метку, порядок
  сортировки, цвет, feature flag, SLA. Статус — не только идентичность, но и маленькая запись.
- **Значениями управляют не разработчики**, либо они настраиваются отдельно для каждого
  тенанта, либо меняются в рантайме без деплоя.
- **Нужны массовые изменения**: название, которое встречается в миллионах строк, можно
  поменять, обновив одну строку в `order_statuses`, а не каждый заказ.

Последний пункт — самый сильный аргумент: изменить одно место, а не все сразу. Если «enum»
на самом деле — поддерживаемый каталог, это правильная модель.

---

## Моё мнение

Для *простого* enum — фиксированного набора состояний на уровне кода вроде жизненного цикла
заказа — я lookup-таблицу не использую и буду возражать против неё на ревью.

Обычно в ответ я слышу: «а если понадобится переименовать значение?» Но мы только
что видели, что таблица для этого не нужна: `AttributeConverter` отвязывает хранимый код от
Java-имени, а изменившаяся метка — это миграция в одну строку. Чтобы пережить переименование,
не нужны ни внешний ключ, ни join в каждом запросе.

Реально же lookup-таблица в этом случае добавляет только постоянные издержки: каждое чтение
либо делает join, либо тянет второй запрос, статус превращается из значения в управляемую
связь, а `switch` по состояниям, который компилятор проверял на полноту, становится поиском
в рантайме, способным промахнуться. Мы променяли значение, которое понимает компилятор, на строку,
которой он не понимает, — ради гибкости, которая фиксированному жизненному циклу не нужна.

Поэтому моё правило — про то, **чем является значение**, а не про переименования:

- Если значение — **только идентичность**: это `SHIPPED`, и всё, — оставляйте enum. Мапьте его
  через `@Enumerated(STRING)`, подложите под него enum-тип Postgres, а если хотите, чтобы
  переименования ничего не стоили, берите `AttributeConverter`.
- Если значение — **запись**, то есть у него есть поля, которые люди редактируют в рантайме,
  то это изначально не enum. Ему нужна таблица.

Решает не переименование, а то, есть ли у значения собственные данные.

---

## Гайд по выбору

| Подход | Что хранит | Когда использовать | Главный риск |
|---|---|---|---|
| `@Enumerated(ORDINAL)` | порядковый номер (`1`) | почти никогда | перестановка молча портит строки |
| `@Enumerated(STRING)` | имя константы (`'PAID'`) | разумный дефолт | переименование осиротит строки |
| Postgres `ENUM` | имя, проверяется базой | нужно, чтобы база отклоняла неверные значения | `ADD VALUE` только добавляет в конец |
| `AttributeConverter` | стабильный код (`'PAID'`) | нужны бесплатные переименования | один маленький класс в поддержке |
| Lookup-таблица | FK на строку | значения несут редактируемые данные | join при каждом чтении |

Надёжный вариант по умолчанию для большинства проектов: **`@Enumerated(STRING)` поверх enum-типа Postgres**
с переходом на **`AttributeConverter`**, как только хранимое значение нужно изолировать
от Java-имени.

---

## Код

Код из этой статьи доступен в
**[github.com/javaAndScriptDeveloper/enums-article](https://github.com/javaAndScriptDeveloper/enums-article)** —
один и тот же enum `OrderStatus`, сохранённый всеми пятью способами, тест на фиксацию ординалов
и round-trip-тест для каждого подхода, который проверяет, что именно подход записывает на диск.
Всё запускается локально с Docker и одной командой `./gradlew test`.

---

## Вместо заключения

Выбор способа хранения enum кажется решением на пять секунд, и именно поэтому стоит
притормозить. Мина с ординалами, ловушка с переименованиями, отсутствие ограничения в базе:
ничто из этого не проявится в день, когда вы пишете аннотацию. Всё всплывёт в день, когда
изменится набор значений, а это случается всегда, обычно спустя много времени после того,
как вы забыли, на какой компромисс пошли.

Хорошая новость: правила по умолчанию простые. Храните имя, поручите базе его проверять,
а код отвяжите от идентификатора, когда это понадобится. Lookup-таблицу оставьте для случаев,
когда перед вами настоящий каталог, а не enum. Сделайте это правильно один раз, и ваши
статусы останутся скучными, а для колонки в таблице это лучший комплимент.

---

## Обсудим

Если вы храните enum иначе или уже обожглись на одной из этих ловушек так, как я не описал,
мне будет интересно об этом узнать. Контакты — в футере.
