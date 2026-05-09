//! Shared helpers for provider Batch APIs (Anthropic Message Batches,
//! OpenAI / Azure OpenAI Batch API). All three follow the same submit /
//! poll / fetch shape over JSONL.

use std::future::Future;
use std::time::Instant;

use crate::error::{CliError, ErrorCode};

use super::provider::BatchOptions;

/// Build the `custom_id` for input slot `i`. Monotonic indices avoid
/// collisions and round-trip cleanly through Anthropic's
/// `^[a-zA-Z0-9_-]{1,64}$` constraint.
pub fn make_custom_id(i: usize) -> String {
    format!("i{i}")
}

/// Inverse of `make_custom_id`. Returns `None` for values we didn't emit.
pub fn parse_custom_id(s: &str) -> Option<usize> {
    s.strip_prefix('i').and_then(|n| n.parse().ok())
}

/// Outcome of a single poll cycle.
pub enum PollState<T> {
    /// Still processing — wait `poll_interval` and try again.
    InProgress,
    /// Terminal success — return this payload.
    Done(T),
    /// Provider reported failure — bail with this error.
    Failed(CliError),
}

/// Poll until `check` returns `Done(t)` / `Failed`, or `opts.timeout`
/// elapses. `check` is invoked once per cycle separated by
/// `opts.poll_interval`.
pub async fn poll_until_done<F, Fut, T>(
    label: &str,
    opts: &BatchOptions,
    mut check: F,
) -> Result<T, CliError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<PollState<T>, CliError>>,
{
    let start = Instant::now();
    loop {
        match check().await? {
            PollState::Done(t) => return Ok(t),
            PollState::Failed(e) => return Err(e),
            PollState::InProgress => {}
        }
        if start.elapsed() >= opts.timeout {
            return Err(CliError::new(
                format!(
                    "{label} batch did not complete within {} seconds",
                    opts.timeout.as_secs(),
                ),
                ErrorCode::LlmBatchTimeout,
            ));
        }
        tokio::time::sleep(opts.poll_interval).await;
    }
}

/// Split a JSONL response body into trimmed, non-empty lines.
pub fn split_jsonl(body: &str) -> impl Iterator<Item = &str> {
    body.lines().map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn custom_id_round_trip() {
        for i in [0usize, 1, 9, 10, 99, 1024, 1_000_000] {
            assert_eq!(parse_custom_id(&make_custom_id(i)), Some(i));
        }
        assert!(parse_custom_id("notmine").is_none());
        assert!(parse_custom_id("ix").is_none());
    }

    #[test]
    fn split_jsonl_handles_blank_and_trailing_newlines() {
        let body = "  {\"a\":1}\n\n{\"b\":2}\n";
        let lines: Vec<&str> = split_jsonl(body).collect();
        assert_eq!(lines, vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[tokio::test]
    async fn poll_loops_then_succeeds() {
        let n = Arc::new(AtomicUsize::new(0));
        let opts = BatchOptions {
            timeout: Duration::from_secs(5),
            poll_interval: Duration::from_millis(1),
        };
        let n_for_check = n.clone();
        let value: u32 = poll_until_done("test", &opts, move || {
            let n = n_for_check.clone();
            async move {
                let v = n.fetch_add(1, Ordering::SeqCst);
                if v < 2 {
                    Ok(PollState::InProgress)
                } else {
                    Ok(PollState::Done(42))
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(value, 42);
        assert_eq!(n.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn poll_times_out() {
        let opts = BatchOptions {
            timeout: Duration::from_millis(15),
            poll_interval: Duration::from_millis(5),
        };
        let err = poll_until_done("test", &opts, || async {
            Ok::<PollState<()>, CliError>(PollState::InProgress)
        })
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmBatchTimeout);
    }

    #[tokio::test]
    async fn poll_propagates_failure() {
        let opts = BatchOptions {
            timeout: Duration::from_secs(5),
            poll_interval: Duration::from_millis(1),
        };
        let err = poll_until_done("test", &opts, || async {
            Ok::<PollState<()>, CliError>(PollState::Failed(CliError::new(
                "bad",
                ErrorCode::LlmBatchPollFailed,
            )))
        })
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmBatchPollFailed);
        assert_eq!(err.message, "bad");
    }
}
