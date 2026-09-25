---
layout: post
title: "How to call Jev from Java 21: typed AI decisions with HttpClient"
date: 2026-09-25
tags: [jev, java, tutorial]
excerpt: "Jev answers typed questions (yes/no, pick one, rate on a scale) with probabilities instead of prose. There is no Java SDK, so here is a small HttpClient integration with retries, tests and an offline stub."
description: "Call the Jev model from Java 21 with HttpClient and Jackson: typed Noul, Choice and Score questions, confidence thresholds, retries, offline tests."
faq:
  - question: "Is there a Java SDK for Jev or TypeSafe?"
    answer: "No. The TypeSafe docs list client SDKs for Python and JavaScript. From Java you call the HTTP API directly: POST https://api.typesafe.ai/v1/systemone with a Bearer key and a JSON body."
  - question: "What question types does Jev support?"
    answer: "Three. Noul is a yes/no question that returns the probability of yes. Choice picks one option from up to 255 you define. Score rates the state along 2 to 10 ordered levels you define."
  - question: "What does the confidence field mean in a Jev answer?"
    answer: "It is a number from 0 to 1 derived from the probability distribution of a Choice or Score answer. A peaked distribution gives high confidence, a flat one gives low confidence. Noul answers do not carry it."
  - question: "Which errors should a Jev client retry?"
    answer: "429 Too Many Requests and 529 Overloaded, with exponential backoff. 401 means a missing or invalid key and 422 means the body failed validation; retrying those changes nothing."
  - question: "Can I test a Jev integration without an API key?"
    answer: "Yes. Run a stub HTTP server in the test JVM that answers with the sample responses from the API reference, and point the client at it. The repo for this article does exactly that."
---

A support ticket comes in: "Help! My payouts have been failing for 3 days." You want three facts out of it: is it urgent, which team owns it, how angry is the customer. The usual LLM route is a prompt that asks for JSON, a parser that hopes, and a retry when the model writes a paragraph instead. Jev, TypeSafe's model, takes a different contract: you declare typed questions, it returns typed answers with probabilities, and the answer can never fall outside the options you gave it. TypeSafe ships SDKs for Python and JavaScript only, so this post wires it into plain Java 21 with `HttpClient` and Jackson.

Code: https://github.com/javaAndScriptDeveloper/jev-how-to

## What you build

A small Gradle project that sends one ticket and three questions in a single request, reads the typed answers and makes the routing decision in Java code. It runs offline: without a key, a stub server inside the same JVM answers with the sample responses from the TypeSafe API reference. With a key, the same client calls the real API.

You need JDK 21 and Gradle 8. No account for the offline run.

## The contract in one request

Everything goes through one endpoint:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

The body has a `state` (a string, or any JSON object or array), a `model` (`jev-latest`), and a `questions` map. You pick every key in that map; the answer comes back under the same key. The docs are explicit that the key is not sent to the model, so the full question goes in `instructions`.

There are three question types:

- `noul` is a yes/no question. The answer is `noul`, the probability of yes, from 0 to 1.
- `choice` picks one option from a map you define, up to 255 options. The answer carries `choice`, `probabilities` and `confidence`.
- `score` rates the state along an ordered list of levels, at least two and at most 10. The answer carries `score`, `legend`, `probabilities` and `confidence`, and `score` can land between two levels.

The request this project sends, taken from the examples in the API reference:

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?",
      "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" }
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": "Pricing, upgrades, new accounts"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

Three questions, one call. The primitives page says every question in a request is evaluated independently and in parallel, and that adding questions barely changes the response time. So the habit to break is one HTTP call per question.

## Run it

Clone the repo and run the tests, then the demo:

```bash
gradle test
gradle run
cat out.txt
```

With no `TYPESAFE_API_KEY` in the environment you get:

```text
No TYPESAFE_API_KEY set: ran against the documented sample responses on a local stub server
model: jev-1.13.0
is_urgent: noul 0.95
department: billing (confidence 0.81)
frustration: score 1.05 (confidence 0.92)
DECISION billing queue, priority high
```

Every number there comes from the sample responses in the TypeSafe API reference, served by the stub. They show the shape of a real answer, not what Jev would say about this ticket today.

## The typed request in Java

`Question` is a record with three factory methods, one per type. Choice options go in a `LinkedHashMap` so the order you wrote is the order you send:

```java
Map<String, String> departments = new LinkedHashMap<>();
departments.put("billing", "Payments, invoicing, refunds");
departments.put("technical", "Bugs, outages, integrations");
departments.put("sales", "Pricing, upgrades, new accounts");

Map<String, Question> questions = new LinkedHashMap<>();
questions.put("is_urgent", Question.noul("Does this convey urgency?",
        "Explicitly time-sensitive", "No urgency expressed"));
questions.put("department", Question.choice("Which team should handle this?", departments));
questions.put("frustration", Question.score("How frustrated is the customer?",
        List.of("Calm", "Frustrated", "Very angry")));
```

## The client: HttpClient, Jackson and the retry rule

The API reference lists four error statuses. `401` is a missing or invalid key, `422` is a body that failed validation, `429` is a rate limit and `529` means TypeSafe is overloaded. Only the last two are worth retrying, and the docs ask for exponential backoff rather than an immediate retry. The official SDKs do this for you. In Java you write it:

```java
Duration backoff = firstBackoff;
for (int attempt = 1; ; attempt++) {
    HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
    int status = response.statusCode();
    if (status >= 200 && status < 300) {
        return SystemOneResponse.from(JSON.readTree(response.body()));
    }
    boolean retryable = status == 429 || status == 529;
    if (!retryable || attempt >= maxAttempts) {
        throw new TypeSafeException(status, response.body());
    }
    Thread.sleep(backoff.toMillis());
    backoff = backoff.multipliedBy(2);
}
```

Two details matter. `TypeSafeException` is thrown for every non-2xx status and carries the status and the JSON error body, so a `422` tells you which field was wrong instead of surfacing as a generic `IOException`. And the `HttpClient` is pinned to HTTP/1.1 with a connect timeout, which keeps it predictable against both the real endpoint and a local test server.

The request body is a Jackson `ObjectNode`. The `state` goes through `valueToTree`, so a plain `String` and a `Map` of structured data both work:

```java
ObjectNode body = JSON.createObjectNode();
body.set("state", JSON.valueToTree(state));
body.put("model", MODEL);
ObjectNode questionsNode = body.putObject("questions");
questions.forEach((id, question) -> questionsNode.set(id, question.toJson()));
```

Responses are parsed from the JSON tree into records (`SystemOneResponse`, `Answer`) by hand. No annotations, no surprises when a field is absent: a Noul answer has no `confidence`, and the record says so with a `null`.

## The decision lives in code

This is the part that makes the typed contract worth it. The model gives you numbers; your code owns the policy:

```java
static Triage decide(SystemOneResponse response) {
    Answer department = response.answers().get("department");
    Answer urgent = response.answers().get("is_urgent");
    Answer frustration = response.answers().get("frustration");

    String queue = department.confidence() < CONFIDENCE_FLOOR ? "human review" : department.choice();
    boolean high = urgent.noul() >= 0.8 || frustration.score() >= 1.5;
    return new Triage(queue, high ? "high" : "normal");
}
```

The TypeSafe confidence page suggests three bands: act automatically when confidence is high, proceed with caution in the middle, do not act when it is low. Its example uses a 0.5 floor for anything the model reports as genuinely uncertain, and it says the right thresholds depend on your domain and your data. The 0.5 floor and the 0.8 and 1.5 cut-offs above are this example's choices, not TypeSafe numbers. When the routing feels wrong you change a constant and rerun the tests. No prompt rewrite.

## Testing without a key

The stub is `com.sun.net.httpserver.HttpServer` on a free port on 127.0.0.1, started inside the test JVM. It records every request, checks the documented rules (a `state`, a known `type`, `instructions`, 1 to 255 Choice options, 2 to 10 Score levels) and answers `401` without a Bearer header and `422` on a malformed question. Valid requests get the sample answers from the API reference, copied verbatim. For a mixed request the stub places each documented answer object under your question id; the docs have no mixed sample, so that stitched response carries no `usage` block.

The tests cover the request shape (path, auth header, body fields), parsing of all three answer types, and the error paths:

```java
@Test
void malformedQuestionIsA422AndIsNotRetried() {
    Map<String, Question> oneLevel = Map.of("frustration",
            Question.score("How frustrated is the customer?", List.of("Calm")));

    TypeSafeException error = assertThrows(TypeSafeException.class,
            () -> client.systemOne(App.TICKET, oneLevel));

    assertEquals(422, error.status());
    assertEquals(1, stub.requests().size());
}
```

A test can also queue a `429` or `529` on the stub and assert that the client retried the expected number of times. Backoff in tests starts at 10 ms, so the suite stays fast.

## Switching to the real API

Create a key in the TypeSafe console, export it in your shell as the environment variable `TYPESAFE_API_KEY` (the same name the Python SDK reads), and run `gradle run` again. The first line of the output then says it called `https://api.typesafe.ai`, and the numbers are Jev's real answers for this ticket. Keep the key out of the repo and out of your shell history; a secrets manager or your CI's secret store is the right home.

## Trade-offs

It is a hosted, paid API. Every ticket you judge leaves your network and goes to TypeSafe, which may rule it out for regulated data before any engineering discussion starts. You also need a key and a budget, and this post has no price numbers because the pages it is based on give none.

There is no Java SDK. You own the retry policy, timeouts and the typed model of the response. The code is small, but it is code you maintain when the API adds a field.

It is built for snap judgments. The primitives page is direct about it: "Does this message convey urgency?" is a good question, "Analyze this message and determine the best course of action" is not. Multi-step reasoning has to be broken into small questions and composed in your code. If your problem is generating text, Jev is the wrong tool.

Noul answers carry no `confidence`. A `noul` of 0.5 means yes and no are equally likely, which is a different thing from "medium". If you need a position on a spectrum, the docs point you to a Score with defined levels instead.

## Wrap-up

The shift is small in code and large in design: stop asking a model for a decision, ask it for typed facts and keep the decision in Java where you can test it. `gradle test` proves the client against the documented contract without a key, and the same client talks to the real endpoint once `TYPESAFE_API_KEY` is set.

Where would you draw the confidence line in your own system before letting a model route anything without a human?
