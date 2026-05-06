//! Download a Drive file to disk. Ported from `src/drive/download.ts`.
//! Handles both export-to-Office (Google-native MIME types) and raw stream
//! download. Includes the path-traversal guard.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futures::StreamExt;
use tokio::io::AsyncWriteExt;

use super::client::DriveClient;
use crate::error::{CliError, ErrorCode};

#[derive(Debug, Clone)]
pub struct ExportTarget {
    pub target_mime: String,
    pub extension: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadFormat {
    Auto,
    Raw,
}

#[derive(Debug, Clone)]
pub struct DownloadTargetFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
}

#[derive(Debug, Clone)]
pub struct DownloadResult {
    pub output_path: PathBuf,
    pub bytes: u64,
    pub mime_type: String,
}

/// Office-byte profile. Mirrors `EXPORT_MIME_MAP` in download.ts.
pub fn office_export_map() -> HashMap<String, ExportTarget> {
    HashMap::from([
        (
            "application/vnd.google-apps.document".to_string(),
            ExportTarget {
                target_mime:
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into(),
                extension: ".docx".into(),
            },
        ),
        (
            "application/vnd.google-apps.spreadsheet".to_string(),
            ExportTarget {
                target_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    .into(),
                extension: ".xlsx".into(),
            },
        ),
        (
            "application/vnd.google-apps.presentation".to_string(),
            ExportTarget {
                target_mime:
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                        .into(),
                extension: ".pptx".into(),
            },
        ),
        (
            "application/vnd.google-apps.drawing".to_string(),
            ExportTarget {
                target_mime: "application/pdf".into(),
                extension: ".pdf".into(),
            },
        ),
    ])
}

/// Text-first profile for the index pipeline. Mirrors `TEXT_EXPORT_MIME_MAP`.
pub fn text_export_map() -> HashMap<String, ExportTarget> {
    HashMap::from([
        (
            "application/vnd.google-apps.document".to_string(),
            ExportTarget {
                target_mime: "text/plain".into(),
                extension: ".txt".into(),
            },
        ),
        (
            "application/vnd.google-apps.spreadsheet".to_string(),
            ExportTarget {
                target_mime: "text/csv".into(),
                extension: ".csv".into(),
            },
        ),
        (
            "application/vnd.google-apps.presentation".to_string(),
            ExportTarget {
                target_mime: "text/plain".into(),
                extension: ".txt".into(),
            },
        ),
        (
            "application/vnd.google-apps.drawing".to_string(),
            ExportTarget {
                target_mime: "application/pdf".into(),
                extension: ".pdf".into(),
            },
        ),
    ])
}

/// Stream a file to disk, exporting if appropriate. Mirrors `downloadToFile`.
pub async fn download_to_file(
    client: &DriveClient,
    file: &DownloadTargetFile,
    dest: &Path,
    format: DownloadFormat,
    export_map: &HashMap<String, ExportTarget>,
) -> Result<DownloadResult, CliError> {
    let export_target = match format {
        DownloadFormat::Auto => export_map.get(&file.mime_type).cloned(),
        DownloadFormat::Raw => None,
    };

    if export_target.is_none()
        && format == DownloadFormat::Auto
        && file.mime_type.starts_with("application/vnd.google-apps.")
    {
        return Err(CliError::new(
            format!(
                "No export path for {}. Use --format raw or download manually from Drive.",
                file.mime_type,
            ),
            ErrorCode::UnsupportedMime,
        ));
    }

    let extension = export_target
        .as_ref()
        .map(|e| e.extension.clone())
        .unwrap_or_else(|| {
            Path::new(&file.name)
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| format!(".{s}"))
                .unwrap_or_default()
        });
    let mime_for_fetch = export_target
        .as_ref()
        .map(|e| e.target_mime.clone())
        .unwrap_or_else(|| file.mime_type.clone());

    let output_path = resolve_output_path(dest, &file.name, &extension)?;
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CliError::new(
                    format!("create_dir_all({}): {e}", parent.display()),
                    ErrorCode::Unknown,
                )
            })?;
        }
    }

    let response = match &export_target {
        Some(t) => client.files_export(&file.id, &t.target_mime).await?,
        None => client.files_get_media(&file.id).await?,
    };

    let bytes = stream_to_disk(response, &output_path).await?;
    Ok(DownloadResult {
        output_path,
        bytes,
        mime_type: mime_for_fetch,
    })
}

fn resolve_output_path(dest: &Path, name: &str, extension: &str) -> Result<PathBuf, CliError> {
    if !(dest.exists() && dest.is_dir()) {
        return Ok(dest.to_path_buf());
    }
    let safe_name = sanitize_name(name);
    let with_ext = if !extension.is_empty()
        && !safe_name
            .to_ascii_lowercase()
            .ends_with(&extension.to_ascii_lowercase())
    {
        format!("{safe_name}{extension}")
    } else {
        safe_name
    };
    let candidate = dest.join(&with_ext);
    // Defence in depth: canonicalize BOTH sides so symlinked temp dirs
    // (e.g. macOS /var/folders → /private/var/folders) compare equal.
    // The candidate file likely doesn't exist yet, so canonicalize its
    // parent (which does) and compare against dest's canonical form.
    let dest_canon = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    let parent_canon = candidate
        .parent()
        .map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()))
        .unwrap_or_else(|| candidate.clone());
    if parent_canon != dest_canon {
        return Err(CliError::new(
            "Download path escapes target directory",
            ErrorCode::BadArg,
        ));
    }
    Ok(candidate)
}

fn sanitize_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    base.chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | '\0') {
                '_'
            } else {
                c
            }
        })
        .collect()
}

async fn stream_to_disk(response: reqwest::Response, output_path: &Path) -> Result<u64, CliError> {
    let mut file = tokio::fs::File::create(output_path).await.map_err(|e| {
        CliError::new(
            format!("create {}: {e}", output_path.display()),
            ErrorCode::Unknown,
        )
    })?;
    let mut total: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| CliError::new(format!("stream chunk: {e}"), ErrorCode::Unknown))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| CliError::new(format!("write: {e}"), ErrorCode::Unknown))?;
        total += chunk.len() as u64;
    }
    file.flush()
        .await
        .map_err(|e| CliError::new(format!("flush: {e}"), ErrorCode::Unknown))?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn export_maps_cover_required_native_mimes() {
        let m = office_export_map();
        for k in [
            "application/vnd.google-apps.document",
            "application/vnd.google-apps.spreadsheet",
            "application/vnd.google-apps.presentation",
            "application/vnd.google-apps.drawing",
        ] {
            assert!(m.contains_key(k), "office map missing {k}");
        }
        assert_eq!(
            text_export_map()
                .get("application/vnd.google-apps.document")
                .unwrap()
                .target_mime,
            "text/plain",
        );
    }

    #[test]
    fn sanitize_name_strips_separators_and_nul() {
        assert_eq!(sanitize_name("foo/bar"), "bar"); // basename strips before /
        assert_eq!(sanitize_name("a\0b\\c"), "a_b_c");
        assert_eq!(sanitize_name("normal-name.txt"), "normal-name.txt");
    }

    #[test]
    fn resolve_output_path_appends_extension_when_dest_is_dir() {
        let tmp = tempfile_dir();
        let p = resolve_output_path(&tmp, "doc", ".pdf").unwrap();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("doc.pdf"));
    }

    #[test]
    fn resolve_output_path_keeps_existing_extension() {
        let tmp = tempfile_dir();
        let p = resolve_output_path(&tmp, "doc.pdf", ".pdf").unwrap();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("doc.pdf"));
    }

    #[test]
    fn resolve_output_path_passes_through_when_dest_is_file_path() {
        let tmp = tempfile_dir();
        let target = tmp.join("explicit.txt");
        let p = resolve_output_path(&target, "doc", ".pdf").unwrap();
        assert_eq!(p, target);
    }

    fn tempfile_dir() -> PathBuf {
        let id = format!(
            "gdrivescope-dl-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        );
        let p = std::env::temp_dir().join(id);
        fs::create_dir_all(&p).unwrap();
        p
    }
}
