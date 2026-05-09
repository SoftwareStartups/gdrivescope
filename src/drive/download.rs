//! Download a Drive file to disk. Handles both export-to-Office (for
//! Google-native MIME types) and raw stream download. Includes a
//! path-traversal guard. Also exposes `download_tree` for recursively
//! pulling every file under a folder (with optional markdown conversion
//! sidecars).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Semaphore};

use super::client::DriveClient;
use super::traversal::{traverse_drive_folder, TraverseOptions, CONCURRENCY_DEFAULT};
use crate::error::{CliError, ErrorCode};
use crate::extract::{extract_to_markdown, should_extract, ExtractOptions};
use crate::graph::model::DriveNodeInput;

const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

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
                    ErrorCode::OutputPathInvalid,
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

/// Stream into `<output>.partial` and atomically rename to `<output>` on
/// success. The `.partial` file is removed on Drop unless `commit()` was
/// called, so a network failure mid-stream cannot leave a truncated file
/// at the user's destination path.
struct PartialFile {
    partial_path: PathBuf,
    target_path: PathBuf,
    file: Option<tokio::fs::File>,
    committed: bool,
}

impl PartialFile {
    async fn create(target_path: &Path) -> Result<Self, CliError> {
        let mut partial = target_path.as_os_str().to_os_string();
        partial.push(".partial");
        let partial_path = PathBuf::from(partial);
        let file = tokio::fs::File::create(&partial_path).await.map_err(|e| {
            CliError::new(
                format!("create {}: {e}", partial_path.display()),
                ErrorCode::OutputPathInvalid,
            )
        })?;
        Ok(Self {
            partial_path,
            target_path: target_path.to_path_buf(),
            file: Some(file),
            committed: false,
        })
    }

    async fn write_all(&mut self, chunk: &[u8]) -> Result<(), CliError> {
        let f = self
            .file
            .as_mut()
            .expect("PartialFile::write_all after commit");
        f.write_all(chunk)
            .await
            .map_err(|e| CliError::new(format!("write: {e}"), ErrorCode::IoFailed))
    }

    async fn commit(mut self) -> Result<(), CliError> {
        if let Some(mut file) = self.file.take() {
            file.flush()
                .await
                .map_err(|e| CliError::new(format!("flush: {e}"), ErrorCode::IoFailed))?;
            // sync_all is best-effort: tmpfs and some network filesystems
            // surface ENOTSUP, which we don't want to fail the download for.
            let _ = file.sync_all().await;
            drop(file);
        }
        tokio::fs::rename(&self.partial_path, &self.target_path)
            .await
            .map_err(|e| {
                CliError::new(
                    format!(
                        "rename {} -> {}: {e}",
                        self.partial_path.display(),
                        self.target_path.display(),
                    ),
                    ErrorCode::IoFailed,
                )
            })?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for PartialFile {
    fn drop(&mut self) {
        if !self.committed {
            // Best-effort sync cleanup. The file may already be gone (commit
            // succeeded but caller hadn't set `committed` yet — not currently
            // possible, but harmless if so).
            let _ = std::fs::remove_file(&self.partial_path);
        }
    }
}

async fn stream_to_disk(response: reqwest::Response, output_path: &Path) -> Result<u64, CliError> {
    let mut partial = PartialFile::create(output_path).await?;
    let mut total: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| CliError::new(format!("stream chunk: {e}"), ErrorCode::IoFailed))?;
        partial.write_all(&chunk).await?;
        total += chunk.len() as u64;
    }
    partial.commit().await?;
    Ok(total)
}

// ────────────────────────── tree download ──────────────────────────

/// Behaviour switches for `download_tree`.
#[derive(Debug, Clone)]
pub struct TreeDownloadOptions {
    pub format: DownloadFormat,
    /// Concurrency cap (clamped to [1, 15]; default 4).
    pub concurrency: Option<usize>,
    /// When set, also write a `<filename>.md` sidecar via the markdown
    /// extractor for every extractable file.
    pub convert: bool,
    /// Skip *conversion* of files larger than this many bytes. Download
    /// itself is unconditional. `None` means no cap.
    pub max_size_bytes: Option<u64>,
    /// Truncate PDF conversion to first N pages. `None` means full PDF.
    pub max_pdf_pages: Option<usize>,
}

impl Default for TreeDownloadOptions {
    fn default() -> Self {
        Self {
            format: DownloadFormat::Auto,
            concurrency: None,
            convert: false,
            max_size_bytes: None,
            max_pdf_pages: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TreeDownloadFile {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub converted: bool,
}

#[derive(Debug, Clone)]
pub struct TreeDownloadFailure {
    pub id: String,
    pub name: String,
    pub path: Option<PathBuf>,
    pub message: String,
    pub stage: TreeDownloadStage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeDownloadStage {
    Download,
    Convert,
}

#[derive(Debug, Default)]
pub struct TreeDownloadResult {
    pub scope_id: String,
    pub scope_name: String,
    pub files: Vec<TreeDownloadFile>,
    pub failures: Vec<TreeDownloadFailure>,
    pub bytes_total: u64,
}

/// Recursively download every file under `scope_id` into `dest_root`.
/// The folder structure under Drive is mirrored under `dest_root`,
/// rooted at the scope folder's own (sanitised) name.
///
/// Per-file failures are collected and returned in `result.failures`;
/// they don't abort the run. Catastrophic failures (auth, traversal
/// abort, fs setup) bubble up as `Err`.
pub async fn download_tree(
    client: &DriveClient,
    scope_id: &str,
    dest_root: &Path,
    opts: TreeDownloadOptions,
) -> Result<TreeDownloadResult, CliError> {
    // Stage 1 — collect every node under the scope via BFS traversal.
    let (tx, mut rx) = mpsc::channel::<DriveNodeInput>(256);
    let traverse_client = client.clone();
    let traverse_opts = TraverseOptions {
        root_id: scope_id.to_string(),
        anchor_root_id: None,
        scope_node: None,
        concurrency: opts.concurrency,
    };
    let traverse_handle: tokio::task::JoinHandle<Result<_, CliError>> =
        tokio::spawn(
            async move { traverse_drive_folder(&traverse_client, traverse_opts, tx).await },
        );

    let mut nodes: Vec<DriveNodeInput> = Vec::new();
    while let Some(n) = rx.recv().await {
        nodes.push(n);
    }
    traverse_handle.await.map_err(|e| {
        CliError::new(
            format!("traversal join: {e}"),
            ErrorCode::DownloadTreeFailed,
        )
    })??;

    if nodes.is_empty() {
        return Err(CliError::new(
            format!(
                "scope {scope_id} produced no nodes; check that the id is a folder you can read"
            ),
            ErrorCode::DownloadTreeFailed,
        ));
    }

    let by_id: HashMap<String, DriveNodeInput> =
        nodes.iter().map(|n| (n.id.clone(), n.clone())).collect();
    let scope_node = by_id
        .values()
        .find(|n| n.id == scope_id)
        .cloned()
        .or_else(|| nodes.first().cloned())
        .ok_or_else(|| {
            CliError::new(
                "scope node missing from traversal",
                ErrorCode::DownloadTreeFailed,
            )
        })?;

    std::fs::create_dir_all(dest_root).map_err(|e| {
        CliError::new(
            format!("create_dir_all({}): {e}", dest_root.display()),
            ErrorCode::OutputPathInvalid,
        )
    })?;
    let dest_root_canon = dest_root.canonicalize().map_err(|e| {
        CliError::new(
            format!("canonicalize {}: {e}", dest_root.display()),
            ErrorCode::OutputPathInvalid,
        )
    })?;

    // Stage 2 — compute relative paths for every leaf file (including
    // export-derived extensions), deduplicating collisions by appending
    // the Drive id's first 8 chars.
    let export_map = office_export_map();
    let leaves: Vec<(DriveNodeInput, PathBuf)> = nodes
        .iter()
        .filter(|n| n.mime_type != FOLDER_MIME)
        .map(|n| {
            (
                n.clone(),
                compute_relative_path(n, &by_id, &export_map, opts.format),
            )
        })
        .collect();
    let leaves = deduplicate_paths(leaves);

    // Stage 3 — concurrent download (+ optional convert).
    let drive_concurrency = opts.concurrency.unwrap_or(CONCURRENCY_DEFAULT).clamp(1, 15);
    let drive_sem = Arc::new(Semaphore::new(drive_concurrency));
    let export_map = Arc::new(export_map);

    let opts = Arc::new(opts);
    let dest_root_canon = Arc::new(dest_root_canon);

    let mut tasks = Vec::with_capacity(leaves.len());
    for (node, rel_path) in leaves {
        let abs_path = dest_root_canon.join(&rel_path);
        // Path-safety: the parent of the candidate must canonicalise to a
        // location inside dest_root_canon.
        if let Err(e) = ensure_inside_root(&abs_path, &dest_root_canon) {
            // Surface as a per-file failure rather than aborting.
            tasks.push(tokio::spawn(async move {
                Err(TreeDownloadFailure {
                    id: node.id.clone(),
                    name: node.name.clone(),
                    path: Some(abs_path),
                    message: e.message,
                    stage: TreeDownloadStage::Download,
                })
            }));
            continue;
        }

        let client = client.clone();
        let sem = drive_sem.clone();
        let opts = opts.clone();
        let export_map = export_map.clone();
        tasks.push(tokio::spawn(async move {
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(e) => {
                    return Err(TreeDownloadFailure {
                        id: node.id.clone(),
                        name: node.name.clone(),
                        path: Some(abs_path.clone()),
                        message: format!("semaphore: {e}"),
                        stage: TreeDownloadStage::Download,
                    });
                }
            };
            process_one_leaf(&client, &node, &abs_path, &opts, &export_map).await
        }));
    }

    let mut result = TreeDownloadResult {
        scope_id: scope_id.to_string(),
        scope_name: scope_node.name.clone(),
        ..Default::default()
    };
    for task in tasks {
        match task.await {
            Ok(Ok(file)) => {
                result.bytes_total += file.bytes;
                result.files.push(file);
            }
            Ok(Err(failure)) => {
                eprintln!(
                    "warn: download: \"{}\" failed: {}",
                    failure.name, failure.message,
                );
                result.failures.push(failure);
            }
            Err(e) => {
                return Err(CliError::new(
                    format!("download task join: {e}"),
                    ErrorCode::DownloadTreeFailed,
                ));
            }
        }
    }
    Ok(result)
}

async fn process_one_leaf(
    client: &DriveClient,
    node: &DriveNodeInput,
    abs_path: &Path,
    opts: &TreeDownloadOptions,
    export_map: &HashMap<String, ExportTarget>,
) -> Result<TreeDownloadFile, TreeDownloadFailure> {
    let target = DownloadTargetFile {
        id: node.id.clone(),
        name: node.name.clone(),
        mime_type: node.mime_type.clone(),
    };
    // Pass the *full file path* (not its parent dir) so download_to_file
    // doesn't re-derive the filename and accidentally double the
    // sanitisation we already did when computing the relative path.
    let dl = match download_to_file(client, &target, abs_path, opts.format, export_map).await {
        Ok(d) => d,
        Err(e) => {
            return Err(TreeDownloadFailure {
                id: node.id.clone(),
                name: node.name.clone(),
                path: Some(abs_path.to_path_buf()),
                message: e.message,
                stage: TreeDownloadStage::Download,
            });
        }
    };

    let mut converted = false;
    if opts.convert && should_extract(&dl.mime_type) {
        let too_large = opts
            .max_size_bytes
            .map(|cap| dl.bytes > cap)
            .unwrap_or(false);
        if !too_large {
            match read_and_extract(&dl.output_path, &dl.mime_type, opts.max_pdf_pages).await {
                Ok(md) => {
                    let mut sidecar_os = dl.output_path.as_os_str().to_os_string();
                    sidecar_os.push(".md");
                    let sidecar = PathBuf::from(sidecar_os);
                    if let Err(e) = tokio::fs::write(&sidecar, md.as_bytes()).await {
                        return Err(TreeDownloadFailure {
                            id: node.id.clone(),
                            name: node.name.clone(),
                            path: Some(sidecar),
                            message: format!("write sidecar: {e}"),
                            stage: TreeDownloadStage::Convert,
                        });
                    }
                    converted = true;
                }
                Err(e) => {
                    return Err(TreeDownloadFailure {
                        id: node.id.clone(),
                        name: node.name.clone(),
                        path: Some(dl.output_path.clone()),
                        message: e.message,
                        stage: TreeDownloadStage::Convert,
                    });
                }
            }
        }
    }

    Ok(TreeDownloadFile {
        id: node.id.clone(),
        name: node.name.clone(),
        path: dl.output_path,
        bytes: dl.bytes,
        converted,
    })
}

async fn read_and_extract(
    path: &Path,
    mime: &str,
    max_pdf_pages: Option<usize>,
) -> Result<String, CliError> {
    let bytes = tokio::fs::read(path).await.map_err(|e| {
        CliError::new(
            format!("read {} for convert: {e}", path.display()),
            ErrorCode::IoFailed,
        )
    })?;
    extract_to_markdown(bytes, mime, ExtractOptions { max_pdf_pages }).await
}

fn compute_relative_path(
    node: &DriveNodeInput,
    by_id: &HashMap<String, DriveNodeInput>,
    export_map: &HashMap<String, ExportTarget>,
    format: DownloadFormat,
) -> PathBuf {
    // Leaf name keeps its export-derived extension (e.g. Google Doc
    // → .docx); ancestor names use only the path-component sanitiser.
    let mut components: Vec<String> = vec![leaf_filename_with_extension(node, export_map, format)];
    let mut cur = node;
    let mut hops = 0;
    while let Some(pid) = cur.parent_id.as_deref() {
        let Some(parent) = by_id.get(pid) else { break };
        components.push(sanitize_path_component(&parent.name));
        cur = parent;
        hops += 1;
        if hops > 256 {
            // Defensive guard against pathological cycles.
            break;
        }
    }
    components.reverse();
    components.iter().collect::<PathBuf>()
}

/// Sanitise a single path component (folder or file name).
///
/// Drive names may contain `/`, `\\`, control characters, and arbitrary
/// trailing whitespace. We do **not** call `Path::new(name).file_name()`
/// here — that would *drop* every character before the last `/` in the
/// Drive name (e.g. `"Meet … 2026/01/07 09:58 CET …"` would silently
/// become `"07 09:58 CET …"`). Instead we replace the offending chars
/// in place and trim surrounding whitespace, collapsing the empty
/// result to `_` so `Path::join` always produces a non-empty segment.
fn sanitize_path_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Compute the leaf filename for a tree-downloaded file, including the
/// extension that `download_to_file` would have appended when given a
/// directory. We need to do this here because tree-mode passes the full
/// file path to `download_to_file`, bypassing its extension logic.
fn leaf_filename_with_extension(
    node: &DriveNodeInput,
    export_map: &HashMap<String, ExportTarget>,
    format: DownloadFormat,
) -> String {
    let base = sanitize_path_component(&node.name);
    let export_ext = match format {
        DownloadFormat::Auto => export_map.get(&node.mime_type).map(|e| e.extension.clone()),
        DownloadFormat::Raw => None,
    };
    let ext = export_ext.or_else(|| {
        Path::new(&base)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{s}"))
    });
    match ext {
        Some(e)
            if !e.is_empty() && !base.to_ascii_lowercase().ends_with(&e.to_ascii_lowercase()) =>
        {
            format!("{base}{e}")
        }
        _ => base,
    }
}

fn deduplicate_paths(items: Vec<(DriveNodeInput, PathBuf)>) -> Vec<(DriveNodeInput, PathBuf)> {
    let mut seen: HashMap<PathBuf, usize> = HashMap::new();
    let mut out = Vec::with_capacity(items.len());
    for (node, path) in items {
        let count = seen.entry(path.clone()).or_insert(0);
        let final_path = if *count == 0 {
            path
        } else {
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let ext = path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            let suffix = node.id.chars().take(8).collect::<String>();
            parent.join(format!("{stem}_{suffix}{ext}"))
        };
        *count += 1;
        out.push((node, final_path));
    }
    out
}

fn ensure_inside_root(candidate: &Path, root_canon: &Path) -> Result<(), CliError> {
    // `candidate` typically does not exist yet; canonicalize its first
    // existing ancestor and verify the chain stays under root.
    let mut probe = candidate.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(p) => probe = p.to_path_buf(),
            None => break,
        }
    }
    let probe_canon = probe.canonicalize().unwrap_or(probe);
    if !probe_canon.starts_with(root_canon) {
        return Err(CliError::new(
            format!(
                "computed path {} escapes target directory {}",
                candidate.display(),
                root_canon.display(),
            ),
            ErrorCode::BadArg,
        ));
    }
    Ok(())
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

    #[tokio::test]
    async fn partial_file_drop_without_commit_removes_partial_and_no_target() {
        let tmp = tempfile_dir();
        let target = tmp.join("payload.bin");
        {
            let mut p = PartialFile::create(&target).await.unwrap();
            p.write_all(b"abc").await.unwrap();
            // intentional: drop without commit
        }
        let mut partial_os = target.as_os_str().to_os_string();
        partial_os.push(".partial");
        assert!(
            !std::path::Path::new(&partial_os).exists(),
            ".partial should be removed on drop",
        );
        assert!(
            !target.exists(),
            "target should never appear without commit",
        );
    }

    #[tokio::test]
    async fn partial_file_commit_renames_to_target() {
        let tmp = tempfile_dir();
        let target = tmp.join("payload2.bin");
        let mut p = PartialFile::create(&target).await.unwrap();
        p.write_all(b"hello").await.unwrap();
        p.commit().await.unwrap();
        assert!(target.exists());
        let mut partial_os = target.as_os_str().to_os_string();
        partial_os.push(".partial");
        assert!(!std::path::Path::new(&partial_os).exists());
        assert_eq!(fs::read(&target).unwrap(), b"hello");
    }

    #[test]
    fn resolve_output_path_passes_through_when_dest_is_file_path() {
        let tmp = tempfile_dir();
        let target = tmp.join("explicit.txt");
        let p = resolve_output_path(&target, "doc", ".pdf").unwrap();
        assert_eq!(p, target);
    }

    #[test]
    fn sanitize_path_component_replaces_separators_in_place() {
        // Slashes inside Drive names are replaced, NOT used as path
        // separators — losing the leading parts of a name would silently
        // collide files into the wrong path.
        assert_eq!(
            sanitize_path_component("Meet Utiligize / LUMO Labs – 2026/01/07 09:58 CET"),
            "Meet Utiligize _ LUMO Labs – 2026_01_07 09:58 CET",
        );
        assert_eq!(
            sanitize_path_component("Material received "),
            "Material received"
        );
        assert_eq!(sanitize_path_component("  "), "_");
        assert_eq!(sanitize_path_component("a\0b"), "a_b");
        assert_eq!(sanitize_path_component("a\nb"), "a_b");
    }

    #[test]
    fn leaf_filename_appends_export_extension_for_google_native() {
        let map = office_export_map();
        let gdoc = drive_node_input(
            "1",
            "Notes-LC-may26",
            "application/vnd.google-apps.document",
            Some("p"),
        );
        assert_eq!(
            leaf_filename_with_extension(&gdoc, &map, DownloadFormat::Auto),
            "Notes-LC-may26.docx",
        );
        // Already-suffixed name doesn't double-suffix.
        let gsheet = drive_node_input(
            "2",
            "ARR growth.xlsx",
            "application/vnd.google-apps.spreadsheet",
            Some("p"),
        );
        assert_eq!(
            leaf_filename_with_extension(&gsheet, &map, DownloadFormat::Auto),
            "ARR growth.xlsx",
        );
        // Raw format → don't append, keep as-is.
        let raw = drive_node_input(
            "3",
            "Notes",
            "application/vnd.google-apps.document",
            Some("p"),
        );
        assert_eq!(
            leaf_filename_with_extension(&raw, &map, DownloadFormat::Raw),
            "Notes",
        );
    }

    #[test]
    fn compute_relative_path_walks_to_scope_root() {
        let map = office_export_map();
        let scope = drive_node_input("scope", "Scope", FOLDER_MIME, None);
        let sub = drive_node_input("sub", "Sub Folder ", FOLDER_MIME, Some("scope"));
        let leaf = drive_node_input("leaf", "doc.pdf", "application/pdf", Some("sub"));
        let by_id: HashMap<String, DriveNodeInput> = [
            (scope.id.clone(), scope.clone()),
            (sub.id.clone(), sub.clone()),
            (leaf.id.clone(), leaf.clone()),
        ]
        .into_iter()
        .collect();
        let p = compute_relative_path(&leaf, &by_id, &map, DownloadFormat::Auto);
        assert_eq!(p, PathBuf::from("Scope").join("Sub Folder").join("doc.pdf"));
    }

    #[test]
    fn compute_relative_path_preserves_slashy_drive_names() {
        let map = office_export_map();
        let scope = drive_node_input("scope", "Scope", FOLDER_MIME, None);
        let leaf = drive_node_input(
            "leaf",
            "Meet / Greet 2026/01/07",
            "application/vnd.google-apps.document",
            Some("scope"),
        );
        let by_id: HashMap<String, DriveNodeInput> = [
            (scope.id.clone(), scope.clone()),
            (leaf.id.clone(), leaf.clone()),
        ]
        .into_iter()
        .collect();
        let p = compute_relative_path(&leaf, &by_id, &map, DownloadFormat::Auto);
        // Slashes replaced; .docx appended.
        assert_eq!(
            p,
            PathBuf::from("Scope").join("Meet _ Greet 2026_01_07.docx"),
        );
    }

    #[test]
    fn deduplicate_paths_appends_id_suffix_for_collisions() {
        let a = drive_node_input(
            "aaaaaaaa1234",
            "Hema.to.doc",
            "application/msword",
            Some("p"),
        );
        let b = drive_node_input(
            "bbbbbbbb5678",
            "Hema.to.doc",
            "application/msword",
            Some("p"),
        );
        let path = PathBuf::from("Scope/Hema.to.doc");
        let out = deduplicate_paths(vec![(a.clone(), path.clone()), (b.clone(), path.clone())]);
        assert_eq!(out[0].1, path);
        assert_eq!(
            out[1].1,
            PathBuf::from("Scope").join("Hema.to_bbbbbbbb.doc"),
        );
    }

    fn drive_node_input(id: &str, name: &str, mime: &str, parent: Option<&str>) -> DriveNodeInput {
        DriveNodeInput {
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            name: name.to_string(),
            mime_type: mime.to_string(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: None,
            metadata: Default::default(),
        }
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
