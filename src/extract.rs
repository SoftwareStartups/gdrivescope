//! Document extraction — a thin wrapper around the native `kreuzberg`
//! crate plus a pure-Rust first-N-pages PDF slicer.
//!
//! The native kreuzberg crate is thread-safe, so the extractor is invoked
//! without any single-flight serialization; the only bound on extraction
//! concurrency is the pipeline's own work limit.

use std::collections::HashSet;
use std::sync::OnceLock;

use crate::error::{CliError, ErrorCode};

/// MIME types Kreuzberg should never see — Drive-only metaformats and the
/// octet-stream fallback (Kreuzberg always errors with "Could not determine
/// MIME type from bytes" on it).
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
            "application/octet-stream",
        ]
        .into_iter()
        .collect()
    })
}

/// Returns true iff Kreuzberg should be invoked for this MIME — skips
/// Drive metaformats and any media (image/audio/video) MIME.
pub fn should_extract(mime: &str) -> bool {
    if skipped_mimes().contains(mime) {
        return false;
    }
    !mime.starts_with("image/") && !mime.starts_with("audio/") && !mime.starts_with("video/")
}

/// Extraction options forwarded into Kreuzberg.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExtractOptions {
    /// When set, slice PDFs to the first N pages before extraction.
    pub max_pdf_pages: Option<usize>,
}

/// Extract a document's bytes to markdown. Errors are wrapped as
/// `EXTRACT_FAILED`. PDFs may be sliced to the first N pages first when
/// `opts.max_pdf_pages` is set; if the slicer fails we fall through to
/// the original bytes rather than aborting extraction.
pub async fn extract_to_markdown(
    bytes: Vec<u8>,
    mime: &str,
    opts: ExtractOptions,
) -> Result<String, CliError> {
    let bytes = match (opts.max_pdf_pages, mime) {
        (Some(n), "application/pdf") if n > 0 => match slice_pdf_to_first_n_pages(&bytes, n) {
            Ok(sliced) => sliced,
            Err(e) => {
                eprintln!(
                    "warn: PDF slice to {n} pages failed ({}); extracting full document",
                    e.message,
                );
                bytes
            }
        },
        _ => bytes,
    };
    let cfg = kreuzberg::ExtractionConfig {
        output_format: kreuzberg::OutputFormat::Markdown,
        // Force the pure-Rust pdf-oxide backend so we don't fall back to
        // dynamically-loaded PDFium at runtime.
        pdf_options: Some(kreuzberg::PdfConfig {
            backend: kreuzberg::PdfBackend::PdfOxide,
            ..Default::default()
        }),
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

/// Rewrite a PDF in memory keeping only its first `n` pages.
fn slice_pdf_to_first_n_pages(bytes: &[u8], n: usize) -> Result<Vec<u8>, CliError> {
    let mut doc = lopdf::Document::load_mem(bytes)
        .map_err(|e| CliError::new(format!("PDF parse: {e}"), ErrorCode::PdfSliceFailed))?;
    let total = doc.get_pages().len();
    if total <= n {
        return Ok(bytes.to_vec());
    }
    let to_drop: Vec<u32> = doc.get_pages().keys().copied().skip(n).collect();
    if !to_drop.is_empty() {
        doc.delete_pages(&to_drop);
    }
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    doc.save_to(&mut out)
        .map_err(|e| CliError::new(format!("PDF write: {e}"), ErrorCode::PdfSliceFailed))?;
    Ok(out)
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

    /// Build a minimal multi-page PDF in memory using lopdf so we can exercise
    /// the slicer without checking in a binary fixture.
    fn build_pdf(num_pages: usize) -> Vec<u8> {
        use lopdf::{dictionary, Document, Object, Stream};

        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut page_ids: Vec<Object> = Vec::with_capacity(num_pages);
        for i in 0..num_pages {
            let content = format!("BT /F1 24 Tf 100 700 Td (Page {}) Tj ET", i + 1);
            let content_id = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
            });
            page_ids.push(page_id.into());
        }
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Count" => num_pages as i64,
                "Kids" => page_ids,
                "Resources" => resources_id,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        let mut buf: Vec<u8> = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn slice_pdf_keeps_first_n_pages() {
        let original = build_pdf(3);
        let sliced = slice_pdf_to_first_n_pages(&original, 1).unwrap();
        let parsed = lopdf::Document::load_mem(&sliced).unwrap();
        assert_eq!(parsed.get_pages().len(), 1);
    }

    #[test]
    fn slice_pdf_no_op_when_already_short() {
        let original = build_pdf(2);
        let sliced = slice_pdf_to_first_n_pages(&original, 5).unwrap();
        assert_eq!(sliced, original);
    }

    #[test]
    fn slice_pdf_rejects_garbage_bytes() {
        let err = slice_pdf_to_first_n_pages(b"not a pdf", 1).unwrap_err();
        assert_eq!(err.code, ErrorCode::PdfSliceFailed);
    }
}
