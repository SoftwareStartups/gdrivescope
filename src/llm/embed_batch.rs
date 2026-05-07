//! Batched-embedding helper + dimension probe validator + retry wrapper.

use std::future::Future;
use std::time::Duration;

use backon::{ExponentialBuilder, Retryable};

use crate::error::{CliError, ErrorCode};

/// Retry transient failures with exponential backoff + jitter for up to
/// 3 attempts. Any `CliError` is treated as retriable because per-provider
/// impls already classify permanent errors (rate-limit codes, 429/503/529)
/// upstream.
pub async fn with_backoff<F, Fut, T>(op: F) -> Result<T, CliError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, CliError>>,
{
    op.retry(
        ExponentialBuilder::default()
            .with_min_delay(Duration::from_millis(500))
            .with_max_delay(Duration::from_secs(8))
            .with_max_times(3)
            .with_jitter(),
    )
    .when(|_| true)
    .await
}

pub async fn batch_embed<F, Fut>(
    texts: &[String],
    batch_size: usize,
    mut call_batch: F,
) -> Result<Vec<Vec<f32>>, CliError>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<Vec<Vec<f32>>, CliError>>,
{
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(batch_size) {
        let batch: Vec<String> = chunk.to_vec();
        let vectors = with_backoff(|| call_batch(batch.clone())).await?;
        out.extend(vectors);
    }
    Ok(out)
}

#[derive(Debug)]
pub struct ProbeOptions<'a> {
    pub actual: Option<usize>,
    pub declared: usize,
    pub provider_label: &'a str,
    pub model: &'a str,
    pub remediation_hint: &'a str,
}

pub fn validate_probe_dimensions(opts: ProbeOptions<'_>) -> Result<(), CliError> {
    let Some(actual) = opts.actual else {
        return Err(CliError::new(
            format!(
                "{} returned an empty embedding probe response",
                opts.provider_label,
            ),
            ErrorCode::EmbedCallFailed,
        ));
    };
    if actual != opts.declared {
        return Err(CliError::new(
            format!(
                "{} model {} produced {}-dim vectors, config declared {}-dim. {}",
                opts.provider_label, opts.model, actual, opts.declared, opts.remediation_hint,
            ),
            ErrorCode::EmbeddingDimMismatch,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn batch_embed_chunks_correctly() {
        let inputs: Vec<String> = (0..5).map(|i| format!("t{i}")).collect();
        let mut seen: Vec<Vec<String>> = Vec::new();
        let result = batch_embed(&inputs, 2, |batch| {
            seen.push(batch.clone());
            async move { Ok::<_, CliError>(batch.iter().map(|_| vec![0.1f32, 0.2]).collect()) }
        })
        .await
        .unwrap();
        assert_eq!(seen.len(), 3); // batches of 2,2,1
        assert_eq!(result.len(), 5);
    }

    #[test]
    fn validate_probe_passes_on_match() {
        validate_probe_dimensions(ProbeOptions {
            actual: Some(1536),
            declared: 1536,
            provider_label: "X",
            model: "m",
            remediation_hint: "h",
        })
        .unwrap();
    }

    #[test]
    fn validate_probe_errors_on_mismatch() {
        let err = validate_probe_dimensions(ProbeOptions {
            actual: Some(3072),
            declared: 1536,
            provider_label: "OpenAI",
            model: "text-embedding-3-large",
            remediation_hint: "Set X.",
        })
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::EmbeddingDimMismatch);
        assert!(err.message.contains("3072"));
    }

    #[test]
    fn validate_probe_errors_on_empty() {
        let err = validate_probe_dimensions(ProbeOptions {
            actual: None,
            declared: 1536,
            provider_label: "X",
            model: "m",
            remediation_hint: "h",
        })
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::EmbedCallFailed);
    }
}
