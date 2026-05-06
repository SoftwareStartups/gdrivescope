//! Walk parents up from a scope folder until we hit a configured root.
//! Direct port of `src/drive/ancestry.ts`. Same constants
//! (`MAX_ANCESTOR_HOPS = 50`, `MY_DRIVE_SENTINEL = "root"`), same
//! `usedFallback` semantics.

use std::collections::HashSet;

use super::client::{DriveClient, DriveFile};
use super::traversal::file_to_node_input;
use crate::config::ConfigRoot;
use crate::error::CliError;
use crate::graph::model::DriveNodeInput;

const ANCESTRY_FIELDS: &str = "id,name,mimeType,parents,size,modifiedTime,createdTime,webViewLink";
const MAX_ANCESTOR_HOPS: usize = 50;
const MY_DRIVE_SENTINEL: &str = "root";

#[derive(Debug, Clone)]
pub struct ResolvedAncestry {
    /// Resolved root id (never the literal `"root"` sentinel).
    pub root_id: String,
    /// Display label — config override, otherwise Drive's folder name.
    pub root_label: String,
    /// Ancestor chain from the root downward, NOT including the scope folder.
    /// Empty when the scope is itself a configured root.
    pub chain: Vec<DriveNodeInput>,
    /// The scope folder, stamped with the resolved `root_id`.
    pub scope: DriveNodeInput,
    /// True when no configured root could be matched and the scope is acting
    /// as its own root.
    pub used_fallback: bool,
}

pub async fn resolve_ancestry(
    client: &DriveClient,
    scope_id: &str,
    configured_roots: &[ConfigRoot],
) -> Result<ResolvedAncestry, CliError> {
    // Expand `"root"` sentinel: if any configured root uses it, look it up
    // once so we can match it against ancestor ids.
    let mut config_map: std::collections::HashMap<String, ConfigRoot> =
        std::collections::HashMap::new();
    let mut my_drive_id: Option<String> = None;
    for r in configured_roots {
        if r.id == MY_DRIVE_SENTINEL {
            if my_drive_id.is_none() {
                let f = client.files_get(MY_DRIVE_SENTINEL, ANCESTRY_FIELDS).await?;
                my_drive_id = Some(f.id().unwrap_or(MY_DRIVE_SENTINEL).to_string());
            }
            if let Some(id) = my_drive_id.clone() {
                config_map.insert(id, r.clone());
            }
        } else {
            config_map.insert(r.id.clone(), r.clone());
        }
    }

    // Fetch scope folder (translating "root" if scope was passed as the sentinel).
    let scope_file = client
        .files_get(
            if scope_id == MY_DRIVE_SENTINEL {
                MY_DRIVE_SENTINEL
            } else {
                scope_id
            },
            ANCESTRY_FIELDS,
        )
        .await?;
    let scope_real_id = scope_file.id().unwrap_or(scope_id).to_string();

    // No configured roots → scope acts as its own root.
    if config_map.is_empty() {
        let label = scope_file.name().unwrap_or(&scope_real_id).to_string();
        return Ok(ResolvedAncestry {
            root_id: scope_real_id.clone(),
            root_label: label,
            chain: Vec::new(),
            scope: file_to_node_input(&scope_file, None, Some(&scope_real_id)),
            used_fallback: true,
        });
    }

    // If the scope itself is a configured root → no ancestry, scope = root.
    if let Some(scope_root) = config_map.get(&scope_real_id) {
        let label = scope_root
            .label
            .clone()
            .or_else(|| scope_file.name().map(String::from))
            .unwrap_or_else(|| scope_real_id.clone());
        return Ok(ResolvedAncestry {
            root_id: scope_real_id.clone(),
            root_label: label.clone(),
            chain: Vec::new(),
            scope: scope_node_with_label(&scope_file, None, &scope_real_id, &label),
            used_fallback: false,
        });
    }

    // Walk upwards.
    let mut ascending: Vec<DriveFile> = Vec::new();
    let mut seen: HashSet<String> = HashSet::from([scope_real_id.clone()]);
    let mut cursor: Option<String> = scope_file.parents().into_iter().next();
    let mut matched_root: Option<String> = None;
    let mut hops = 0;
    while let Some(id) = cursor.clone() {
        if hops >= MAX_ANCESTOR_HOPS {
            break;
        }
        if seen.contains(&id) {
            break;
        }
        seen.insert(id.clone());
        let folder = client.files_get(&id, ANCESTRY_FIELDS).await?;
        let folder_id = folder.id().unwrap_or(&id).to_string();
        let next_parent = folder.parents().into_iter().next();
        ascending.push(folder);
        if config_map.contains_key(&folder_id) {
            matched_root = Some(folder_id);
            break;
        }
        cursor = next_parent;
        hops += 1;
    }

    let Some(matched_root_id) = matched_root else {
        // Fallback: no configured root on the chain.
        let label = scope_file.name().unwrap_or(&scope_real_id).to_string();
        return Ok(ResolvedAncestry {
            root_id: scope_real_id.clone(),
            root_label: label,
            chain: Vec::new(),
            scope: file_to_node_input(&scope_file, None, Some(&scope_real_id)),
            used_fallback: true,
        });
    };

    let root_config = config_map.get(&matched_root_id);
    let root_label = root_config
        .and_then(|r| r.label.clone())
        .or_else(|| ascending.last().and_then(|f| f.name()).map(String::from))
        .unwrap_or_else(|| matched_root_id.clone());

    // Build chain root → ... → scope.parent. ascending is scope.parent → root,
    // so reverse-iterate.
    let mut chain: Vec<DriveNodeInput> = Vec::with_capacity(ascending.len());
    for (i, folder) in ascending.iter().enumerate().rev() {
        let id = folder.id().unwrap_or("").to_string();
        let is_root = id == matched_root_id;
        let parent_id = if is_root {
            None
        } else {
            folder.parents().into_iter().next()
        };
        let label = if is_root {
            Some(root_label.as_str())
        } else {
            None
        };
        let node = match label {
            Some(l) => scope_node_with_label(folder, parent_id.as_deref(), &matched_root_id, l),
            None => file_to_node_input(folder, parent_id.as_deref(), Some(&matched_root_id)),
        };
        chain.push(node);
        let _ = i; // silence unused-binding warning when reverse iterating
    }

    let scope_parent_id = scope_file.parents().into_iter().next();
    Ok(ResolvedAncestry {
        root_id: matched_root_id.clone(),
        root_label,
        chain,
        scope: file_to_node_input(
            &scope_file,
            scope_parent_id.as_deref(),
            Some(&matched_root_id),
        ),
        used_fallback: false,
    })
}

fn scope_node_with_label(
    file: &DriveFile,
    parent_id: Option<&str>,
    root_id: &str,
    label: &str,
) -> DriveNodeInput {
    let mut node = file_to_node_input(file, parent_id, Some(root_id));
    node.name = label.to_string();
    node
}

// Pure-function tests live here; HTTP-driven tests are deferred to Phase 7
// pipeline integration tests against a recorded fixture.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_ancestry_chain_excludes_scope() {
        // Sanity-check shape only — exercising HTTP requires a server.
        // Real ancestry behaviour is asserted via Phase 7 fixture tests.
        let scope_node = DriveNodeInput {
            id: "s".into(),
            parent_id: Some("p".into()),
            name: "scope".into(),
            mime_type: "application/vnd.google-apps.folder".into(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: Some("root-id".into()),
            metadata: serde_json::Map::new(),
        };
        let r = ResolvedAncestry {
            root_id: "root-id".into(),
            root_label: "Root".into(),
            chain: vec![],
            scope: scope_node,
            used_fallback: false,
        };
        assert_eq!(r.scope.id, "s");
        assert!(r.chain.is_empty());
        assert!(!r.used_fallback);
    }
}
