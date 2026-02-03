---
layout: post
title: "How to write tests"
date: 2025-07-24
tags: [testing]
excerpt: "How to write tests fast, easy and being able to understand them next sprint"
description: "Practical guide to writing maintainable tests: reusable test infrastructure, clear assertions, stable test isolation, and patterns that make tests easy to understand and maintain."
tech_icon: "fas fa-vial"
---
Well, this topic can sound not like a rocket science. Writing tests looks like not so cool as developing features or 
creating architecture. This can explain why usually test code looks much less good than main code. I know no developer who would 
spend time writing tests instead of developing if he is a given a choice. But what if 

Lets state what we want from tests: 
- they should be written fast
- they should be understandable
- they should actual safe us from unexpected cases
- they should be stable and independent from each other or run order

so lets see how I propose to implement these requirements

to begin with lets begin with re-using code. This is both actual to re-using in terms of one service to re-using among microservices
through some test artifact;

I name it AbstractTest and this is base class in which would be stored common code for unit and integration tests.

## The AbstractTest Pattern

```java
public abstract class AbstractTest {

    protected ObjectMapper objectMapper = new ObjectMapper()
        .registerModule(new JavaTimeModule());

    protected <T> T readJson(String path, Class<T> clazz) {
        try (InputStream is = getClass().getResourceAsStream(path)) {
            return objectMapper.readValue(is, clazz);
        } catch (IOException e) {
            throw new RuntimeException("Failed to read test fixture: " + path, e);
        }
    }

    protected void assertEqualsIgnoringTimestamps(Object expected, Object actual) {
        // Compare objects ignoring createdAt, updatedAt fields
    }
}
```

This base class gives you:
- Shared ObjectMapper configuration (no more forgetting JavaTimeModule)
- Helper methods for reading test fixtures from resources
- Custom assertion methods for common patterns

## Test Structure: Given-When-Then

Every test should follow a clear structure:

```java
@Test
void shouldRejectOrderWhenInventoryInsufficient() {
    // Given
    var product = createProduct(10);
    var order = createOrder(product.getId(), 15);

    // When
    var result = orderService.placeOrder(order);

    // Then
    assertThat(result.isSuccess()).isFalse();
    assertThat(result.getError()).isEqualTo("INSUFFICIENT_INVENTORY");
}
```

This structure makes tests self-documenting. Anyone can understand what's being tested without reading implementation details.

## Fixtures and Test Data

Stop creating test data inline. Create a `TestFixtures` class:

```java
public class TestFixtures {

    public static User validUser() {
        return User.builder()
            .id(UUID.randomUUID())
            .email("test@example.com")
            .status(UserStatus.ACTIVE)
            .build();
    }

    public static User validUser(Consumer<User.UserBuilder> customizer) {
        var builder = User.builder()
            .id(UUID.randomUUID())
            .email("test@example.com")
            .status(UserStatus.ACTIVE);
        customizer.accept(builder);
        return builder.build();
    }
}
```

Usage becomes clean and intention-revealing:

```java
var user = TestFixtures.validUser(u -> u.status(UserStatus.SUSPENDED));
```

## Test Independence

Each test must be able to run in isolation. Never rely on test execution order. Use `@BeforeEach` to set up fresh state:

```java
@BeforeEach
void setUp() {
    userRepository.deleteAll();
    // Or use @Transactional to auto-rollback
}
```

For integration tests, consider using Testcontainers to get fresh database instances.

## What Makes a Good Assertion

Bad:
```java
assertTrue(result != null && result.size() > 0);
```

Good:
```java
assertThat(result)
    .isNotEmpty()
    .hasSize(3)
    .extracting(User::getEmail)
    .containsExactly("a@test.com", "b@test.com", "c@test.com");
```

AssertJ gives you readable assertions that produce helpful failure messages.

## Summary

Good tests are:
1. **Fast** - use mocks for external dependencies
2. **Isolated** - no shared state between tests
3. **Readable** - Given-When-Then structure
4. **Maintainable** - reusable fixtures and base classes

Invest in your test infrastructure. It pays dividends every sprint.
