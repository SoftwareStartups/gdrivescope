//! Shared helpers for provider Batch APIs (Anthropic Message Batches,
//! OpenAI / Azure OpenAI Batch API). All three follow the same submit /
//! poll / fetch shape over JSONL.

use std::future::Future;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::{CliError, ErrorCode};

use super::provider::{BatchOptions, LlmSummarizeInput, LlmSummary};

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

/// Parse a JSONL batch results body into per-input result slots.
///
/// Each line must carry a `custom_id` produced by [`make_custom_id`]; the
/// index decoded from it determines the output slot. `extract` decides
/// whether the line is a per-item success (returns `Ok(LlmSummary)`) or a
/// per-item failure (returns `Err(CliError)`); both outcomes land in the
/// returned `Vec<Result<…>>`. Missing slots, duplicate slots, malformed
/// JSON, missing/unrecognized/out-of-range `custom_id` values map to an
/// outer `Err(LlmBatchPollFailed)` — they signal a broken batch envelope,
/// not a per-item failure.
pub fn parse_batch_jsonl<F>(
    label: &str,
    body: &str,
    expected_len: usize,
    extract: F,
) -> Result<Vec<Result<LlmSummary, CliError>>, CliError>
where
    F: Fn(&Value) -> Result<LlmSummary, CliError>,
{
    let mut out: Vec<Option<Result<LlmSummary, CliError>>> =
        (0..expected_len).map(|_| None).collect();
    for line in split_jsonl(body) {
        let v: Value = serde_json::from_str(line).map_err(|e| {
            CliError::new(
                format!("{label} batch results parse failed: {e}"),
                ErrorCode::LlmBatchPollFailed,
            )
        })?;
        let custom_id = v.get("custom_id").and_then(|x| x.as_str()).ok_or_else(|| {
            CliError::new(
                format!("{label} batch result line missing custom_id"),
                ErrorCode::LlmBatchPollFailed,
            )
        })?;
        let idx = parse_custom_id(custom_id).ok_or_else(|| {
            CliError::new(
                format!("{label} batch returned unrecognized custom_id: {custom_id}"),
                ErrorCode::LlmBatchPollFailed,
            )
        })?;
        if idx >= expected_len {
            return Err(CliError::new(
                format!("{label} batch returned out-of-range custom_id: {custom_id}"),
                ErrorCode::LlmBatchPollFailed,
            ));
        }
        out[idx] = Some(extract(&v));
    }

    out.into_iter()
        .enumerate()
        .map(|(i, slot)| {
            slot.ok_or_else(|| {
                CliError::new(
                    format!("{label} batch did not return a result for input {i}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })
        })
        .collect()
}

/// Provider-specific hooks for a Batch API. `run_batch` owns the shared
/// submit → poll → fetch → parse shape; this trait encodes only what
/// differs between providers.
///
/// `SubmitHandle` is whatever the provider needs to poll status (typically
/// a batch id or a status URL). `FetchHandle` is whatever it needs to
/// download results once polling reports terminal success (an
/// `output_file_id`, a `results_url`, etc.).
#[async_trait]
pub trait BatchOps: Send + Sync {
    type SubmitHandle: Send + Sync;
    type FetchHandle: Send + Sync;

    /// Human-readable provider label used in error messages and
    /// `parse_batch_jsonl`.
    fn label(&self) -> &'static str;

    /// Submit `inputs` as one provider-side batch. Returns whatever handle
    /// `poll` needs to check status.
    async fn submit(&self, inputs: &[LlmSummarizeInput]) -> Result<Self::SubmitHandle, CliError>;

    /// Check status once. Return `InProgress` to keep polling, `Done` with
    /// the fetch handle when terminal-success, or `Failed` for terminal-
    /// failure (the surrounding `poll_until_done` propagates `Failed` as
    /// the outer error).
    async fn poll(
        &self,
        handle: &Self::SubmitHandle,
    ) -> Result<PollState<Self::FetchHandle>, CliError>;

    /// Download the JSONL results body.
    async fn fetch(&self, handle: &Self::FetchHandle) -> Result<String, CliError>;

    /// Decode one parsed JSONL line into either an `LlmSummary` (per-item
    /// success) or a `CliError` (per-item failure). Outer `parse_batch_jsonl`
    /// already handles missing `custom_id`, malformed JSON, and slot
    /// allocation.
    fn parse_line(&self, line: &Value) -> Result<LlmSummary, CliError>;
}

/// Drive a Batch API end-to-end: submit, poll until terminal, fetch
/// JSONL, and demultiplex per-item results.
pub async fn run_batch<O: BatchOps>(
    ops: &O,
    inputs: &[LlmSummarizeInput],
    opts: &BatchOptions,
) -> Result<Vec<Result<LlmSummary, CliError>>, CliError> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let submit_handle = ops.submit(inputs).await?;
    let fetch_handle = poll_until_done(ops.label(), opts, || ops.poll(&submit_handle)).await?;
    let body = ops.fetch(&fetch_handle).await?;
    parse_batch_jsonl(ops.label(), &body, inputs.len(), |v| ops.parse_line(v))
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
