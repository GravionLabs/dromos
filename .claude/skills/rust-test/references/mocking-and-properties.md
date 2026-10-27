# Mocking and property tests

## mockall

Add `mockall` as a dev-dependency. Put `#[automock]` on a trait that is a real boundary (HTTP, DB, clock).

```rust
use mockall::predicate::eq;

#[cfg_attr(test, mockall::automock)]
pub trait Clock {
    fn now(&self) -> u64;
}

#[test]
fn expired_token_is_rejected() {
    let mut clock = MockClock::new();
    clock.expect_now().times(1).return_const(2_000u64);
    assert!(!is_valid(&clock, 1_000));
}
```

- `.times(n)` verifies call counts; `.with(eq(x))` verifies arguments
- Async traits: put `#[async_trait]` above `#[automock]` (attribute order matters)

## Async tests

```rust
#[tokio::test]
async fn fetch_returns_body() {
    let body = fetch(&client_stub()).await.unwrap();
    assert_eq!(body, "ok");
}
```

## proptest (optional)

Use for parsers, serializers and invariants over many inputs.

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn roundtrip(s in "[a-z]{0,16}") {
        prop_assert_eq!(decode(&encode(&s)).unwrap(), s);
    }
}
```

Failing cases are stored in `proptest-regressions/`; commit that directory.
