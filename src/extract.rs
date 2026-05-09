//! Document extraction — wraps the native `kreuzberg` crate.
//!
//! For PDFs we ask kreuzberg to insert page markers and truncate the
//! resulting markdown to the first N pages. The pure-Rust pdf_oxide backend
//! handles many PDFs that strict pre-extraction parsers reject.
//!
//! Zip archives (e.g. Docusign envelope downloads) are opened in-memory and
//! each inner document is fed back through the extractor (depth-1
//! recursion) so signed PDFs and certificates are indexed alongside the
//! envelope.
//!
//! When kreuzberg's `pdf_oxide` backend cannot parse a PDF it transparently
//! falls back to libpdfium. This binary is built without a libpdfium
//! runtime dependency, so we recognize the dlopen failure and surface it as
//! a clean per-document extraction error.

use std::collections::HashSet;
use std::io::Read;
use std::pin::Pin;
use std::sync::OnceLock;

use crate::error::{CliError, ErrorCode};

const ZIP_MIMES: [&str; 2] = ["application/zip", "application/x-zip-compressed"];
const ZIP_MAX_DEPTH: usize = 1;
const ZIP_ENTRY_MAX_BYTES: u64 = 50 * 1024 * 1024;
const PAGE_MARKER_FORMAT: &str = "\n\n<!-- PAGE {page_num} -->\n\n";

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
    /// When set, truncate PDF markdown to the first N pages.
    pub max_pdf_pages: Option<usize>,
}

/// Extract a document's bytes to markdown. Errors are wrapped as
/// `EXTRACT_FAILED`.
pub async fn extract_to_markdown(
    bytes: Vec<u8>,
    mime: &str,
    opts: ExtractOptions,
) -> Result<String, CliError> {
    extract_at_depth(bytes, mime.to_string(), opts, 0).await
}

type ExtractFuture = Pin<Box<dyn std::future::Future<Output = Result<String, CliError>> + Send>>;

fn extract_at_depth(
    bytes: Vec<u8>,
    mime: String,
    opts: ExtractOptions,
    depth: usize,
) -> ExtractFuture {
    Box::pin(async move {
        if ZIP_MIMES.contains(&mime.as_str()) {
            return extract_zip_to_markdown(bytes, opts, depth).await;
        }

        let max_pages = opts.max_pdf_pages.filter(|n| *n > 0);
        let truncate_pdf_pages = mime == "application/pdf" && max_pages.is_some();

        let mut cfg = kreuzberg::ExtractionConfig {
            output_format: kreuzberg::OutputFormat::Markdown,
            // Pure-Rust pdf_oxide backend; metadata extraction is unused
            // and routes through libpdfium even on the oxide path.
            pdf_options: Some(kreuzberg::PdfConfig {
                backend: kreuzberg::PdfBackend::PdfOxide,
                extract_metadata: false,
                ..Default::default()
            }),
            ..Default::default()
        };
        if truncate_pdf_pages {
            cfg.pages = Some(kreuzberg::PageConfig {
                insert_page_markers: true,
                marker_format: PAGE_MARKER_FORMAT.to_string(),
                ..Default::default()
            });
        }

        let result = kreuzberg::extract_bytes(&bytes, &mime, &cfg)
            .await
            .map_err(|e| translate_kreuzberg_error(&mime, &e.to_string()))?;

        if let Some(n) = max_pages.filter(|_| truncate_pdf_pages) {
            Ok(truncate_to_first_n_pages(&result.content, n))
        } else {
            Ok(result.content)
        }
    })
}

/// Translate a Kreuzberg error string into a `CliError`. Recognizes the
/// libpdfium dlopen failure that kreuzberg emits when its hidden pdfium
/// fallback runs on a host without the library installed.
fn translate_kreuzberg_error(mime: &str, msg: &str) -> CliError {
    if msg.contains("Pdfium initialization failed")
        || msg.contains("Failed to bind to system Pdfium")
    {
        return CliError::new(
            "PDF parser could not read this document".to_string(),
            ErrorCode::ExtractFailed,
        );
    }
    CliError::new(
        format!("Kreuzberg failed ({mime}): {msg}"),
        ErrorCode::ExtractFailed,
    )
}

/// Truncate markdown produced with `<!-- PAGE n -->` markers to the first
/// `n` pages. If a marker for page `n+1` is not found the markdown is
/// returned unchanged.
fn truncate_to_first_n_pages(md: &str, n: usize) -> String {
    if n == 0 {
        return String::new();
    }
    let marker = format!("<!-- PAGE {} -->", n + 1);
    let Some(idx) = md.find(&marker) else {
        return md.to_string();
    };
    let mut end = idx;
    while end > 0 {
        let last = md.as_bytes()[end - 1];
        if last == b'\n' || last == b'\r' || last == b' ' || last == b'\t' {
            end -= 1;
        } else {
            break;
        }
    }
    md[..end].to_string()
}

/// Read a zip archive in memory and recursively extract each inner
/// document. Caps recursion at depth 1 (no zip-of-zips) and per-entry size
/// at `ZIP_ENTRY_MAX_BYTES` to defend against archive bombs.
async fn extract_zip_to_markdown(
    bytes: Vec<u8>,
    opts: ExtractOptions,
    depth: usize,
) -> Result<String, CliError> {
    if depth >= ZIP_MAX_DEPTH {
        return Err(CliError::new(
            "zip nesting exceeds depth limit".to_string(),
            ErrorCode::ExtractFailed,
        ));
    }

    let entries = tokio::task::spawn_blocking(move || read_zip_entries(&bytes))
        .await
        .map_err(|e| {
            CliError::new(format!("zip task panicked: {e}"), ErrorCode::ExtractFailed)
        })??;

    let mut sections: Vec<String> = Vec::new();
    for (name, inner_bytes) in entries {
        let inner_mime = sniff_mime_from_filename(&name);
        if !should_extract(&inner_mime) {
            continue;
        }
        match extract_at_depth(inner_bytes, inner_mime, opts, depth + 1).await {
            Ok(md) => {
                let trimmed = md.trim();
                if !trimmed.is_empty() {
                    sections.push(format!("## {name}\n\n{trimmed}"));
                }
            }
            Err(_) => continue,
        }
    }

    if sections.is_empty() {
        return Err(CliError::new(
            "zip archive contained no extractable documents".to_string(),
            ErrorCode::ExtractFailed,
        ));
    }
    Ok(sections.join("\n\n"))
}

fn read_zip_entries(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, CliError> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| CliError::new(format!("zip open: {e}"), ErrorCode::ExtractFailed))?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut file = match archive.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if file.is_dir() || file.size() == 0 {
            continue;
        }
        let name = match file.enclosed_name() {
            Some(p) => p.to_string_lossy().into_owned(),
            None => continue,
        };
        if name.starts_with("__MACOSX/") || name.ends_with("/.DS_Store") || name == ".DS_Store" {
            continue;
        }
        if file.size() > ZIP_ENTRY_MAX_BYTES {
            continue;
        }
        let mut buf = Vec::with_capacity(file.size() as usize);
        if file.read_to_end(&mut buf).is_err() {
            continue;
        }
        out.push((name, buf));
    }
    Ok(out)
}

/// Map a zip entry filename to a best-effort MIME type. Unknown extensions
/// map to `application/octet-stream`, which `should_extract` filters out.
fn sniff_mime_from_filename(name: &str) -> String {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "ppt" => "application/vnd.ms-powerpoint",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "odt" => "application/vnd.oasis.opendocument.text",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "json" => "application/json",
        "eml" => "message/rfc822",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    };
    mime.to_string()
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
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/zip",
            "application/x-zip-compressed",
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

    #[test]
    fn truncate_keeps_first_n_pages() {
        let md = "page1 body\n\n<!-- PAGE 2 -->\n\npage2 body\n\n<!-- PAGE 3 -->\n\npage3 body";
        let out = truncate_to_first_n_pages(md, 1);
        assert_eq!(out, "page1 body");
        let out2 = truncate_to_first_n_pages(md, 2);
        assert_eq!(out2, "page1 body\n\n<!-- PAGE 2 -->\n\npage2 body");
    }

    #[test]
    fn truncate_no_marker_returns_full() {
        let md = "single page only, no markers";
        assert_eq!(truncate_to_first_n_pages(md, 5), md);
    }

    #[test]
    fn truncate_zero_pages_returns_empty() {
        assert_eq!(truncate_to_first_n_pages("anything", 0), "");
    }

    #[test]
    fn truncate_preserves_when_n_exceeds_pages() {
        let md = "p1\n\n<!-- PAGE 2 -->\n\np2";
        assert_eq!(truncate_to_first_n_pages(md, 5), md);
    }

    #[test]
    fn sniff_known_extensions() {
        assert_eq!(sniff_mime_from_filename("a.pdf"), "application/pdf");
        assert_eq!(
            sniff_mime_from_filename("report.XLSX"),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        assert_eq!(sniff_mime_from_filename("notes.txt"), "text/plain");
        assert_eq!(
            sniff_mime_from_filename("unknown.bin"),
            "application/octet-stream"
        );
    }

    #[test]
    fn translate_pdfium_error_returns_clean_message() {
        let raw = "Parsing error: Metadata extraction failed: Pdfium initialization failed (initialize Pdfium): Failed to bind to system Pdfium library: LoadLibraryError(...)";
        let err = translate_kreuzberg_error("application/pdf", raw);
        assert_eq!(err.message, "PDF parser could not read this document");
        assert_eq!(err.code, ErrorCode::ExtractFailed);
    }

    #[test]
    fn translate_other_error_keeps_context() {
        let err = translate_kreuzberg_error("application/zip", "boom");
        assert!(err.message.contains("application/zip"));
        assert!(err.message.contains("boom"));
        assert_eq!(err.code, ErrorCode::ExtractFailed);
    }

    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut writer = zip::ZipWriter::new(cursor);
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, content) in entries {
                writer.start_file(*name, opts).unwrap();
                std::io::Write::write_all(&mut writer, content).unwrap();
            }
            writer.finish().unwrap();
        }
        buf
    }

    #[tokio::test]
    async fn extract_zip_concatenates_inner_text_entries() {
        let zip_bytes = build_zip(&[
            ("first.txt", b"alpha content"),
            ("second.txt", b"bravo content"),
        ]);
        let out = extract_to_markdown(zip_bytes, "application/zip", ExtractOptions::default())
            .await
            .unwrap();
        assert!(
            out.contains("## first.txt"),
            "missing first header in {out}"
        );
        assert!(out.contains("alpha content"), "missing first body in {out}");
        assert!(
            out.contains("## second.txt"),
            "missing second header in {out}"
        );
        assert!(
            out.contains("bravo content"),
            "missing second body in {out}"
        );
    }

    #[tokio::test]
    async fn extract_zip_skips_macosx_metadata() {
        let zip_bytes = build_zip(&[
            ("__MACOSX/._first.txt", b"junk"),
            ("first.txt", b"real content"),
        ]);
        let out = extract_to_markdown(zip_bytes, "application/zip", ExtractOptions::default())
            .await
            .unwrap();
        assert!(out.contains("real content"));
        assert!(!out.contains("junk"));
    }

    #[tokio::test]
    async fn extract_zip_rejects_nested_zip() {
        let inner = build_zip(&[("hello.txt", b"hi")]);
        let outer = build_zip(&[("inner.zip", &inner)]);
        let err = extract_to_markdown(outer, "application/zip", ExtractOptions::default())
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::ExtractFailed);
    }

    #[tokio::test]
    async fn extract_x_zip_compressed_alias() {
        let zip_bytes = build_zip(&[("only.txt", b"x-zip variant works")]);
        let out = extract_to_markdown(
            zip_bytes,
            "application/x-zip-compressed",
            ExtractOptions::default(),
        )
        .await
        .unwrap();
        assert!(out.contains("x-zip variant works"));
    }
}
