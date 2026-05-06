//! Document extraction. Replaces `src/extract/{kreuzberg,mime-filter,
//! pdf-slice,wasm-console-filter}.ts` with a thin wrapper around the
//! native `kreuzberg` Rust crate.
//!
//! Critically, **no semaphore wrapper.** The TS port had to serialize every
//! `extractBytes()` call through `createSemaphore(1)` because concurrent
//! @kreuzberg/wasm calls corrupted the wasm-bindgen externref table. The
//! native crate is thread-safe, so we drop the cap entirely; the only
//! bound on extraction concurrency is the pipeline's own work limit.
//!
//! Note on first-N-pages PDF slicing: the TS port did this with `pdf-lib`
//! to drop bandwidth into Kreuzberg's WASM build. The kreuzberg-rs 4.9 API
//! does not expose first-N truncation at the extractor level, so the
//! `--max-pdf-pages` flag becomes a pipeline-level concern (Phase 7) — for
//! now we extract the whole document and rely on the LLM phase's input
//! truncation. A future revision can layer in pre-extraction slicing via
//! `lopdf` if document size becomes a real cost.

use std::collections::HashSet;
use std::sync::OnceLock;

use crate::error::{CliError, ErrorCode};

/// MIME types to skip outright. Mirrors `SKIPPED_MIMES` in
/// `src/extract/mime-filter.ts`.
fn skipped_mimes() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "application/vnd.google-apps.folder",
            "application/vnd.google-apps.form",
            "application/vnd.google-apps.site",
            "application/vnd.google-apps.map",
            "application/vnd.google-apps.jam",
            "application/vnd.google-apps.shortcut",
            // Drive's fallback when MIME is unknown — Kreuzberg always errors
            // with "Could not determine MIME type from bytes" on octet-stream.
            "application/octet-stream",
        ]
        .into_iter()
        .collect()
    })
}

/// Returns true iff Kreuzberg should be invoked for this MIME. Mirrors
/// `shouldExtract` in `src/extract/mime-filter.ts`.
pub fn should_extract(mime: &str) -> bool {
    if skipped_mimes().contains(mime) {
        return false;
    }
    !mime.starts_with("image/") && !mime.starts_with("audio/") && !mime.starts_with("video/")
}

/// Extraction options forwarded into Kreuzberg. Reserved for Phase 7 to
/// route `--max-pdf-pages` once a slicing path lands.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExtractOptions {}

/// Extract a document's bytes to markdown. Replaces `extractToMarkdown` in
/// `src/extract/kreuzberg.ts`. Errors are wrapped as `EXTRACT_FAILED`.
pub async fn extract_to_markdown(
    bytes: Vec<u8>,
    mime: &str,
    _opts: ExtractOptions,
) -> Result<String, CliError> {
    let cfg = kreuzberg::ExtractionConfig {
        output_format: kreuzberg::OutputFormat::Markdown,
        ..Default::default()
    };
    let result = kreuzberg::extract_bytes(&bytes, mime, &cfg)
        .await
        .map_err(|e| {
            CliError::new(
                format!("Kreuzberg failed ({mime}): {e}"),
                ErrorCode::ExtractFailed,
            )
        })?;
    Ok(result.content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skipped_mimes_block_extraction() {
        for mime in [
            "application/vnd.google-apps.folder",
            "application/vnd.google-apps.shortcut",
            "application/octet-stream",
        ] {
            assert!(!should_extract(mime), "expected {mime} to be skipped");
        }
    }

    #[test]
    fn media_prefixes_block_extraction() {
        for mime in ["image/png", "audio/mpeg", "video/mp4"] {
            assert!(!should_extract(mime), "expected {mime} to be skipped");
        }
    }

    #[test]
    fn document_mimes_extract() {
        for mime in [
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "text/plain",
            "text/markdown",
            "application/json",
        ] {
            assert!(should_extract(mime), "expected {mime} to be extracted");
        }
    }

    #[tokio::test]
    async fn extract_text_plain_round_trips() {
        let bytes = b"hello world\nsecond line".to_vec();
        let out = extract_to_markdown(bytes, "text/plain", ExtractOptions::default())
            .await
            .unwrap();
        assert!(out.contains("hello world"));
    }
}
