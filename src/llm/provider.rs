//! `LlmProvider` trait + summarize input/output types.

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::classification::Classification;
use crate::error::CliError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmSummary {
    pub summary: String,
    pub classification: Classification,
    pub key_topics: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct LlmSummarizeInput {
    pub markdown: String,
    pub filename: String,
    pub path: String,
    pub mime_type: String,
}

/// Tunables for async batch summarization. Providers that go through their
/// vendor's Batch API submit once, then poll until results are available.
#[derive(Debug, Clone, Copy)]
pub struct BatchOptions {
    /// Hard cap on total wall time spent waiting for the batch to end.
    /// Hitting this returns `LlmBatchTimeout` — the provider-side batch is
    /// not canceled, just abandoned.
    pub timeout: Duration,
    /// Delay between polls of the batch status endpoint.
    pub poll_interval: Duration,
}

impl Default for BatchOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(1800),
            poll_interval: Duration::from_secs(10),
        }
    }
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn name(&self) -> &str;
    async fn summarize(&self, input: &LlmSummarizeInput) -> Result<LlmSummary, CliError>;

    /// Capability check — when `true`, the pipeline routes summarization
    /// through `summarize_batch` (one provider-side batch per scope).
    /// When `false`, the pipeline falls back to per-file `summarize`.
    fn supports_batch(&self) -> bool {
        false
    }

    /// Submit `inputs` as one provider-side batch, poll until processing
    /// has ended, return per-input results in the same order as `inputs`.
    ///
    /// * Outer `Err` — whole-batch failure (submit/poll/timeout).
    /// * Inner `Err` per element — that single request failed (e.g., the
    ///   provider returned an `errored` result line). Other elements may
    ///   still have succeeded.
    ///
    /// Only called when `supports_batch()` returns `true`.
    async fn summarize_batch(
        &self,
        inputs: &[LlmSummarizeInput],
        opts: &BatchOptions,
    ) -> Result<Vec<Result<LlmSummary, CliError>>, CliError> {
        let _ = (inputs, opts);
        unreachable!("summarize_batch called on a provider where supports_batch() is false")
    }
}
