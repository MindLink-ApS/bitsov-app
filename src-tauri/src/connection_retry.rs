//! Bounded startup retries. Callers decide which typed errors are transient;
//! authorization refusals and pin failures must never be retried here.
use std::future::Future;
use std::time::Duration;

pub async fn while_connecting<T, E, F, Fut>(
    mut attempt: F,
    retryable: impl Fn(&E) -> bool,
    timed_out: impl Fn() -> E,
) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut backoff = Duration::from_millis(250);
    loop {
        match tokio::time::timeout_at(deadline, attempt()).await {
            Ok(Err(error)) if retryable(&error) => {}
            Ok(result) => return result,
            Err(_) => return Err(timed_out()),
        }
        let wake = (tokio::time::Instant::now() + backoff).min(deadline);
        tokio::time::sleep_until(wake).await;
        if tokio::time::Instant::now() >= deadline { return Err(timed_out()); }
        backoff = (backoff * 2).min(Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test(start_paused = true)]
    async fn startup_retries_transient_failures_then_connects() {
        let calls = Cell::new(0);
        let start = tokio::time::Instant::now();
        let result = while_connecting(|| {
            calls.set(calls.get() + 1);
            std::future::ready(if calls.get() < 4 { Err("unavailable") } else { Ok("paired") })
        }, |error| *error == "unavailable", || "timeout").await;
        assert_eq!(result, Ok("paired"));
        assert_eq!(start.elapsed(), Duration::from_millis(1750));
    }

    #[tokio::test(start_paused = true)]
    async fn startup_refusal_is_immediate() {
        let start = tokio::time::Instant::now();
        let result: Result<(), _> = while_connecting(|| async { Err("refused") },
            |error| *error == "unavailable", || "timeout").await;
        assert_eq!(result, Err("refused"));
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn startup_unavailable_or_hung_is_bounded_to_thirty_seconds() {
        for hung in [false, true] {
            let start = tokio::time::Instant::now();
            let result: Result<(), _> = while_connecting(|| async {
                if hung { std::future::pending::<()>().await; }
                Err("unavailable")
            }, |_| true, || "timeout").await;
            assert_eq!(result, Err("timeout"));
            assert_eq!(start.elapsed(), Duration::from_secs(30));
        }
    }
}
