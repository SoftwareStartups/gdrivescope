//! BFS folder traversal with bounded concurrency via
//! `tokio::sync::Semaphore`.
//!
//! Emits `DriveNodeInput`s through a `tokio::sync::mpsc::Sender` rather
//! than invoking a closure per node — the channel gives natural
//! backpressure against the pipeline's LLM/embed workers and avoids the
//! boxed-future closure dance Rust would otherwise need.

use std::collections::{HashSet, VecDeque};

use tokio::sync::{mpsc, Semaphore};

use super::client::{DriveClient, DriveFile};
use crate::error::{CliError, ErrorCode};
use crate::graph::model::DriveNodeInput;

const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const SHORTCUT_MIME: &str = "application/vnd.google-apps.shortcut";

const LIST_FIELDS: &str =
    "nextPageToken, files(id,name,mimeType,parents,size,modifiedTime,createdTime,webViewLink,shortcutDetails)";
const ROOT_FIELDS: &str = "id,name,mimeType,parents,size,modifiedTime,createdTime,webViewLink";
const SHORTCUT_TARGET_FIELDS: &str = "id,name,mimeType,size,modifiedTime,createdTime,webViewLink";

pub const CONCURRENCY_DEFAULT: usize = 4;
pub const CONCURRENCY_MAX: usize = 15;
const PAGE_SIZE: usize = 1000;

#[derive(Debug, Clone, Default)]
pub struct TraverseOptions {
    /// BFS starting folder id. For ancestry-aware runs, callers pass the
    /// scope folder id and supply a pre-resolved `scope_node`.
    pub root_id: String,
    /// `root_id` stamped onto every emitted node. Defaults to `root_id`.
    pub anchor_root_id: Option<String>,
    /// When provided, traversal skips the seed `files.get` and uses this
    /// node as the BFS entry. Caller is expected to have emitted it (and
    /// any ancestors) already.
    pub scope_node: Option<DriveNodeInput>,
    pub concurrency: Option<usize>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TraverseResult {
    pub visited: u64,
    pub folders: u64,
    pub files: u64,
    /// Folders or shortcut targets we couldn't fetch. Detail messages are
    /// emitted to stderr; non-zero means the tree is not fully indexed.
    pub skipped_refs: u64,
}

/// BFS traverse, emitting nodes through `tx`. Caller spawns this on a tokio
/// task and reads the receiver.
pub async fn traverse_drive_folder(
    client: &DriveClient,
    opts: TraverseOptions,
    tx: mpsc::Sender<DriveNodeInput>,
) -> Result<TraverseResult, CliError> {
    let max = clamp_concurrency(opts.concurrency);
    let sem = Semaphore::new(max);

    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    let mut counters = TraverseResult::default();

    let bfs_start_id = if let Some(scope) = &opts.scope_node {
        scope.id.clone()
    } else {
        let root = client.files_get(&opts.root_id, ROOT_FIELDS).await?;
        let resolved = root.id().unwrap_or(&opts.root_id).to_string();
        let anchor = opts
            .anchor_root_id
            .clone()
            .unwrap_or_else(|| resolved.clone());
        let node = file_to_node_input(&root, None, Some(&anchor));
        send_node(&tx, node).await?;
        counters.visited += 1;
        counters.folders += 1;
        resolved
    };
    let anchor = opts
        .anchor_root_id
        .clone()
        .unwrap_or_else(|| bfs_start_id.clone());

    seen.insert(bfs_start_id.clone());
    queue.push_back(bfs_start_id);

    while !queue.is_empty() {
        let batch: Vec<String> = queue.drain(..).collect();

        // Fan out folder visits up to the semaphore limit. Each future
        // gates on `sem.acquire()` internally.
        let visits = batch
            .iter()
            .map(|folder_id| visit_folder(client, &sem, folder_id, &anchor, &tx));
        let results = futures::future::join_all(visits).await;

        for r in results {
            let v = r?;
            counters.visited += v.visited;
            counters.folders += v.folders;
            counters.files += v.files;
            counters.skipped_refs += v.skipped_refs;
            for new_folder in v.discovered_folders {
                if seen.insert(new_folder.clone()) {
                    queue.push_back(new_folder);
                }
            }
        }
    }

    Ok(counters)
}

#[derive(Debug, Default)]
struct VisitResult {
    visited: u64,
    folders: u64,
    files: u64,
    skipped_refs: u64,
    discovered_folders: Vec<String>,
}

async fn visit_folder(
    client: &DriveClient,
    sem: &Semaphore,
    folder_id: &str,
    anchor: &str,
    tx: &mpsc::Sender<DriveNodeInput>,
) -> Result<VisitResult, CliError> {
    let _permit = sem
        .acquire()
        .await
        .map_err(|e| CliError::new(format!("semaphore: {e}"), ErrorCode::Unknown))?;

    let entries = match list_all_children(client, folder_id).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "warn: traversal: folder {folder_id} could not be listed ({})",
                e.message,
            );
            return Ok(VisitResult {
                skipped_refs: 1,
                ..Default::default()
            });
        }
    };

    let mut out = VisitResult::default();
    for file in entries {
        // For folder shortcuts, descend into the target id even though the
        // emitted node keeps the shortcut's own id.
        let raw_mime = file.mime_type().unwrap_or_default().to_string();
        let raw_target = file.shortcut_target_id().map(String::from);

        let resolved = if raw_mime == SHORTCUT_MIME {
            match resolve_shortcut(client, &file).await {
                Some(f) => f,
                None => {
                    out.skipped_refs += 1;
                    continue;
                }
            }
        } else {
            file
        };

        let node = file_to_node_input(&resolved, Some(folder_id), Some(anchor));
        let resolved_mime = resolved.mime_type().unwrap_or_default().to_string();
        send_node(tx, node).await?;
        out.visited += 1;

        if resolved_mime == FOLDER_MIME {
            out.folders += 1;
            // Folder shortcut: descend into the original shortcut target.
            // Direct folder: descend into the file's own id.
            let child_id = if raw_mime == SHORTCUT_MIME {
                raw_target
            } else {
                resolved.id().map(String::from)
            };
            if let Some(child) = child_id {
                out.discovered_folders.push(child);
            }
        } else {
            out.files += 1;
        }
    }
    Ok(out)
}

async fn list_all_children(
    client: &DriveClient,
    folder_id: &str,
) -> Result<Vec<DriveFile>, CliError> {
    let mut all = Vec::new();
    let mut token: Option<String> = None;
    let q = format!("'{folder_id}' in parents and trashed = false");
    loop {
        let page = client
            .files_list(&q, LIST_FIELDS, token.as_deref(), PAGE_SIZE)
            .await?;
        all.extend(page.files);
        match page.next_page_token {
            Some(t) => token = Some(t),
            None => break,
        }
    }
    Ok(all)
}

async fn resolve_shortcut(client: &DriveClient, shortcut: &DriveFile) -> Option<DriveFile> {
    let target_id = shortcut.shortcut_target_id()?;
    let target = match client.files_get(target_id, SHORTCUT_TARGET_FIELDS).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "warn: traversal: shortcut \"{}\" → {} unresolved ({})",
                shortcut
                    .name()
                    .unwrap_or(shortcut.id().unwrap_or("(no id)")),
                target_id,
                e.message,
            );
            return None;
        }
    };
    // Synthesize: keep the shortcut's id + parents, take the target's
    // name/mime/size/etc. Mirrors `resolveShortcut` in `traversal.ts`.
    let mut merged = shortcut.raw.clone();
    for k in [
        "name",
        "mimeType",
        "size",
        "modifiedTime",
        "createdTime",
        "webViewLink",
    ] {
        if let Some(v) = target.raw.get(k) {
            merged.insert(k.to_string(), v.clone());
        }
    }
    Some(DriveFile { raw: merged })
}

async fn send_node(
    tx: &mpsc::Sender<DriveNodeInput>,
    node: DriveNodeInput,
) -> Result<(), CliError> {
    tx.send(node)
        .await
        .map_err(|_| CliError::new("traversal consumer dropped", ErrorCode::Unknown))
}

pub(crate) fn file_to_node_input(
    file: &DriveFile,
    parent_id: Option<&str>,
    root_id: Option<&str>,
) -> DriveNodeInput {
    DriveNodeInput {
        id: file.id().unwrap_or("").to_string(),
        parent_id: parent_id.map(str::to_string),
        name: file.name().unwrap_or("(untitled)").to_string(),
        mime_type: file
            .mime_type()
            .unwrap_or("application/octet-stream")
            .to_string(),
        size: file.size(),
        modified_time: file.modified_time().map(str::to_string),
        created_time: file.created_time().map(str::to_string),
        web_view_link: file.web_view_link().map(str::to_string),
        root_id: root_id.map(str::to_string),
        metadata: file.metadata().clone(),
    }
}

fn clamp_concurrency(n: Option<usize>) -> usize {
    let raw = n.unwrap_or(CONCURRENCY_DEFAULT);
    raw.clamp(1, CONCURRENCY_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive_file(json: serde_json::Value) -> DriveFile {
        DriveFile {
            raw: json.as_object().cloned().unwrap_or_default(),
        }
    }

    #[test]
    fn clamp_concurrency_bounds() {
        assert_eq!(clamp_concurrency(None), CONCURRENCY_DEFAULT);
        assert_eq!(clamp_concurrency(Some(0)), 1);
        assert_eq!(clamp_concurrency(Some(1)), 1);
        assert_eq!(clamp_concurrency(Some(8)), 8);
        assert_eq!(clamp_concurrency(Some(99)), CONCURRENCY_MAX);
    }

    #[test]
    fn file_to_node_input_carries_metadata_verbatim() {
        let f = drive_file(serde_json::json!({
            "id": "fid",
            "name": "doc.pdf",
            "mimeType": "application/pdf",
            "size": "100",
            "modifiedTime": "2024-01-01T00:00:00Z",
            "webViewLink": "https://drive.google.com/.../fid",
            "customField": "preserved"
        }));
        let n = file_to_node_input(&f, Some("parent-1"), Some("root-1"));
        assert_eq!(n.id, "fid");
        assert_eq!(n.name, "doc.pdf");
        assert_eq!(n.parent_id.as_deref(), Some("parent-1"));
        assert_eq!(n.root_id.as_deref(), Some("root-1"));
        assert_eq!(n.size, Some(100));
        assert!(n.metadata.contains_key("customField"));
        assert_eq!(
            n.metadata.get("customField").and_then(|v| v.as_str()),
            Some("preserved"),
        );
    }

    #[test]
    fn file_to_node_input_handles_missing_fields() {
        let f = drive_file(serde_json::json!({}));
        let n = file_to_node_input(&f, None, None);
        assert_eq!(n.name, "(untitled)");
        assert_eq!(n.mime_type, "application/octet-stream");
        assert_eq!(n.size, None);
        assert!(n.parent_id.is_none());
    }
}
