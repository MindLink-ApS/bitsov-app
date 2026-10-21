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
        if tokio::time::Instant::now() >= deadline {
            return Err(timed_out());
        }
        backoff = (backoff * 2).min(Duration::from_secs(2));
    }
}

/// One process-wide admission budget for remote bootstrap, HTTP and WebSocket
/// handshakes. Callers may retry freely; only this gate may open a remote socket.
#[derive(Default)]
pub struct RemoteRetry {
    attempt: tokio::sync::Mutex<()>,
    state: std::sync::Mutex<RemoteRetryState>,
    failure_revision: std::sync::atomic::AtomicU64,
    last_error: std::sync::Mutex<ConnectionFailure>,
    endpoint: std::sync::Mutex<Option<String>>,
}

#[derive(Default)]
struct ConnectionFailure {
    revision: u64,
    error: Option<crate::remote_access::ConnectionError>,
}

#[derive(Default)]
struct RemoteRetryState {
    failures: u32,
    next: Option<tokio::time::Instant>,
    retrying: bool,
}

impl RemoteRetry {
    /// Only after the old attach and all proxy tasks have stopped, and only
    /// for a different pinned node. Reconnect must retain the server deadline.
    pub fn reset_for_replacement(&self) {
        *self.state.lock().unwrap() = RemoteRetryState::default();
        self.clear_connection_error();
    }

    pub fn set_endpoint(&self, endpoint: &str) {
        *self.endpoint.lock().unwrap() = Some(endpoint.to_owned());
    }

    pub fn connection_error(&self) -> Option<crate::remote_access::ConnectionError> {
        self.last_error.lock().unwrap().error.clone()
    }

    pub fn clear_connection_error(&self) {
        let mut last = self.last_error.lock().unwrap();
        last.revision = last.revision.wrapping_add(1);
        last.error = None;
    }

    pub fn connection_error_revision(&self) -> u64 {
        self.last_error.lock().unwrap().revision
    }

    /// A successful retained tunnel must not erase a newer proxy failure.
    pub fn clear_connection_error_if_unchanged(&self, revision: u64) {
        let mut last = self.last_error.lock().unwrap();
        if last.revision == revision {
            last.revision = last.revision.wrapping_add(1);
            last.error = None;
        }
    }

    /// Rounded up for UI and scheduling, using a monotonic clock.
    pub fn remaining(&self) -> Option<u64> {
        self.state.lock().unwrap().next.and_then(|next| {
            let left = next.saturating_duration_since(tokio::time::Instant::now());
            (!left.is_zero()).then(|| left.as_secs() + u64::from(left.subsec_nanos() != 0))
        })
    }

    pub fn is_retrying(&self) -> bool {
        self.state.lock().unwrap().retrying
    }

    pub fn failure_revision(&self) -> u64 {
        self.failure_revision
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Recovery over an existing HTTP tunnel may succeed without a handshake.
    /// Never erase a newer, still-active server deadline in that case.
    pub fn clear_expired(&self) {
        let mut state = self.state.lock().unwrap();
        if state
            .next
            .is_none_or(|next| next <= tokio::time::Instant::now())
        {
            *state = RemoteRetryState::default();
        }
    }

    pub fn failed(&self, error: &crate::remote_access::RemoteError) {
        use crate::remote_access::RemoteError;
        {
            let mut last = self.last_error.lock().unwrap();
            last.revision = last.revision.wrapping_add(1);
            last.error = Some(crate::remote_access::ConnectionError::for_endpoint(error, self.endpoint.lock().unwrap().as_deref()));
        }
        let mut state = self.state.lock().unwrap();
        let hint = match error {
            RemoteError::RateLimited(seconds) => *seconds,
            RemoteError::HandshakeUnavailable => 0,
            _ => return,
        };
        let base = (1u64 << state.failures.min(5)).min(30).max(hint);
        // Additive jitter never shortens the server's minimum or permits a burst.
        // A randomness failure still retains the full backoff.
        let mut random = [0u8; 2];
        let _ = getrandom::getrandom(&mut random);
        let delay = Duration::from_secs(base)
            + Duration::from_millis(u64::from(u16::from_le_bytes(random)) % 1001);
        let next = tokio::time::Instant::now() + delay;
        state.next = Some(state.next.map_or(next, |old| old.max(next)));
        state.failures = state.failures.saturating_add(1);
        state.retrying = true;
        self.failure_revision
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    pub async fn run<T, F, Fut>(&self, operation: F) -> Result<T, crate::remote_access::RemoteError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, crate::remote_access::RemoteError>>,
    {
        use crate::remote_access::RemoteError;
        // Serialize through the outcome so queued requests see the first
        // failure's deadline before they can send another handshake.
        let _attempt = self.attempt.lock().await;
        if let Some(seconds) = self.remaining() {
            return Err(RemoteError::Waiting(seconds));
        }
        // Cancellation must not leave the next queued caller free to burst.
        self.state.lock().unwrap().next =
            Some(tokio::time::Instant::now() + Duration::from_secs(1));
        let result = operation().await;
        match &result {
            Ok(_) => {
                *self.state.lock().unwrap() = RemoteRetryState::default();
                self.clear_connection_error();
            },
            Err(RemoteError::HandshakeUnavailable | RemoteError::RateLimited(_)) => {
                self.failed(result.as_ref().err().unwrap());
            }
            Err(error) => {
                *self.state.lock().unwrap() = RemoteRetryState::default();
                self.failed(error);
            },
        }
        result
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
        let result = while_connecting(
            || {
                calls.set(calls.get() + 1);
                std::future::ready(if calls.get() < 4 {
                    Err("unavailable")
                } else {
                    Ok("paired")
                })
            },
            |error| *error == "unavailable",
            || "timeout",
        )
        .await;
        assert_eq!(result, Ok("paired"));
        assert_eq!(start.elapsed(), Duration::from_millis(1750));
    }

    #[tokio::test(start_paused = true)]
    async fn startup_refusal_is_immediate() {
        let start = tokio::time::Instant::now();
        let result: Result<(), _> = while_connecting(
            || async { Err("refused") },
            |error| *error == "unavailable",
            || "timeout",
        )
        .await;
        assert_eq!(result, Err("refused"));
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn startup_unavailable_or_hung_is_bounded_to_thirty_seconds() {
        for hung in [false, true] {
            let start = tokio::time::Instant::now();
            let result: Result<(), _> = while_connecting(
                || async {
                    if hung {
                        std::future::pending::<()>().await;
                    }
                    Err("unavailable")
                },
                |_| true,
                || "timeout",
            )
            .await;
            assert_eq!(result, Err("timeout"));
            assert_eq!(start.elapsed(), Duration::from_secs(30));
        }
    }
}

#[cfg(test)]
mod remote_tests {
    use super::*;
    use crate::remote_access::RemoteError;
    use std::cell::Cell;

    #[tokio::test(start_paused = true)]
    async fn remote_failures_back_off_and_manual_retries_cannot_bypass_the_deadline() {
        let retry = RemoteRetry::default();
        let calls = Cell::new(0);
        for floor in [1, 2, 4, 8, 16, 30, 30] {
            let result: Result<(), _> = retry
                .run(|| async {
                    calls.set(calls.get() + 1);
                    Err(RemoteError::HandshakeUnavailable)
                })
                .await;
            assert!(matches!(result, Err(RemoteError::HandshakeUnavailable)));
            let wait = retry.remaining().unwrap();
            assert!(
                (floor..=floor + 1).contains(&wait),
                "wait={wait}, floor={floor}"
            );
            let before = calls.get();
            for _ in 0..20 {
                let _: Result<(), _> = retry
                    .run(|| async {
                        calls.set(calls.get() + 1);
                        Ok(())
                    })
                    .await;
            }
            assert_eq!(
                calls.get(),
                before,
                "polls and Reconnect must not send early"
            );
            tokio::time::advance(Duration::from_secs(wait)).await;
        }
        retry.run(|| async { Ok(()) }).await.unwrap();
        assert_eq!(retry.remaining(), None);
        let _: Result<(), _> = retry
            .run(|| async { Err(RemoteError::HandshakeUnavailable) })
            .await;
        assert!(
            retry.remaining().unwrap() <= 2,
            "success resets exponential backoff"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn remote_hint_survives_cancellation_and_reconnect_and_is_not_a_thirty_second_timeout() {
        let retry = RemoteRetry::default();
        let _: Result<(), _> = retry
            .run(|| async { Err(RemoteError::RateLimited(60)) })
            .await;
        tokio::time::advance(Duration::from_secs(30)).await;
        assert!(retry.remaining().unwrap() >= 30);
        let mut called = false;
        let result = retry
            .run(|| async {
                called = true;
                Ok(())
            })
            .await;
        assert!(result.is_err());
        assert!(!called);
        tokio::time::advance(Duration::from_secs(31)).await;
        retry
            .run(|| async {
                called = true;
                Ok(())
            })
            .await
            .unwrap();
        assert!(called);
    }

    #[tokio::test(start_paused = true)]
    async fn recovery_clears_expired_debt_but_never_a_newer_hint() {
        let retry = RemoteRetry::default();
        retry.failed(&RemoteError::RateLimited(3));
        let revision = retry.failure_revision();
        tokio::time::advance(Duration::from_secs(4)).await;
        retry.clear_expired();
        assert!(!retry.is_retrying());
        retry.failed(&RemoteError::RateLimited(60));
        retry.clear_expired();
        assert!(retry.is_retrying());
        assert!(retry.remaining().unwrap() >= 60);
        assert!(retry.failure_revision() > revision);
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_callers_share_one_failure_and_cancellation_does_not_burst() {
        let retry = std::sync::Arc::new(RemoteRetry::default());
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..20 {
            let retry = retry.clone();
            let calls = calls.clone();
            tasks.push(tokio::spawn(async move {
                retry
                    .run(|| async {
                        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        Err::<(), _>(RemoteError::HandshakeUnavailable)
                    })
                    .await
            }));
        }
        for task in tasks {
            assert!(task.await.unwrap().is_err());
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(2)).await;
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            retry.run(|| async { std::future::pending::<Result<(), RemoteError>>().await })
        )
        .await
        .is_err());
        assert!(retry.run(|| async { Ok(()) }).await.is_err());
        tokio::time::advance(Duration::from_secs(1)).await;
        retry.run(|| async { Ok(()) }).await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn remote_hard_refusals_do_not_become_automatic_retries() {
        for error in [
            RemoteError::Refused("revoked".into()),
            RemoteError::Transport("pin mismatch".into()),
        ] {
            let retry = RemoteRetry::default();
            assert!(retry.run(|| async { Err::<(), _>(error) }).await.is_err());
            assert!(!retry.is_retrying());
            assert_eq!(retry.remaining(), None);
        }
    }
}

#[cfg(test)]
mod onboarding_tests {
    use super::*;
    use crate::remote_access::{ConnectionErrorKind, RemoteError};

    #[test]
    fn older_recovery_cannot_clear_a_newer_connection_failure() {
        let retry = RemoteRetry::default();
        retry.failed(&RemoteError::Unclaimed);
        let before = retry.connection_error_revision();
        retry.failed(&RemoteError::LocalNetwork);
        retry.clear_connection_error_if_unchanged(before);
        assert_eq!(retry.connection_error().unwrap().kind, ConnectionErrorKind::LocalNetwork);
        let current = retry.connection_error_revision();
        retry.clear_connection_error_if_unchanged(current);
        assert!(retry.connection_error().is_none());
    }

    #[tokio::test]
    async fn permission_failure_is_actionable_until_a_successful_retry() {
        let retry = RemoteRetry::default();
        let _ = retry.run(|| async { Err::<(), _>(RemoteError::LocalNetwork) }).await;
        assert_eq!(retry.connection_error().unwrap().kind, ConnectionErrorKind::LocalNetwork);
        assert!(retry.remaining().is_none());
        retry.clear_expired();
        assert!(retry.connection_error().is_some());
        retry.run(|| async { Ok(()) }).await.unwrap();
        assert!(retry.connection_error().is_none());
    }
}
