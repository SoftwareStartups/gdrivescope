//! TOML workspace config at `~/.config/gdrivescope/config.toml`.
//!
//! Round-trips losslessly: `[[roots]]` array, `[folders]` map, and per-
//! section `[llm]`, `[embedding]`, `[extraction]`, `[ollama]`, `[azure]`
//! overrides.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CliError, ErrorCode};

/// One configured Drive root. `[[roots]]` entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigRoot {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmbeddingConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OllamaConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_dimensions: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AzureConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_deployment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_deployment: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ExtractionConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_pdf_pages: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    #[serde(default)]
    pub roots: Vec<ConfigRoot>,
    #[serde(default)]
    pub folders: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "is_default_llm")]
    pub llm: Option<LlmConfig>,
    #[serde(default, skip_serializing_if = "is_default_embedding")]
    pub embedding: Option<EmbeddingConfig>,
    #[serde(default, skip_serializing_if = "is_default_extraction")]
    pub extraction: Option<ExtractionConfig>,
    #[serde(default, skip_serializing_if = "is_default_ollama")]
    pub ollama: Option<OllamaConfig>,
    #[serde(default, skip_serializing_if = "is_default_azure")]
    pub azure: Option<AzureConfig>,
}

fn is_default_llm(v: &Option<LlmConfig>) -> bool {
    v.as_ref()
        .map(|c| c.provider.is_none() && c.model.is_none())
        .unwrap_or(true)
}
fn is_default_embedding(v: &Option<EmbeddingConfig>) -> bool {
    v.as_ref()
        .map(|c| c.provider.is_none() && c.model.is_none() && c.dimensions.is_none())
        .unwrap_or(true)
}
fn is_default_extraction(v: &Option<ExtractionConfig>) -> bool {
    v.as_ref()
        .map(|c| c.max_size_bytes.is_none() && c.max_pdf_pages.is_none())
        .unwrap_or(true)
}
fn is_default_ollama(v: &Option<OllamaConfig>) -> bool {
    v.as_ref()
        .map(|c| {
            c.host.is_none()
                && c.llm_model.is_none()
                && c.embedding_model.is_none()
                && c.embedding_dimensions.is_none()
        })
        .unwrap_or(true)
}
fn is_default_azure(v: &Option<AzureConfig>) -> bool {
    v.as_ref()
        .map(|c| {
            c.endpoint.is_none()
                && c.api_version.is_none()
                && c.llm_deployment.is_none()
                && c.embedding_deployment.is_none()
        })
        .unwrap_or(true)
}

pub fn config_path() -> Result<PathBuf, CliError> {
    if let Ok(p) = std::env::var("GDRIVESCOPE_CONFIG") {
        return Ok(PathBuf::from(p));
    }
    Ok(crate::utils::config_dir()?.join("config.toml"))
}

pub fn load_workspace_config() -> Result<WorkspaceConfig, CliError> {
    let path = config_path()?;
    load_workspace_config_at(&path)
}

pub fn load_workspace_config_at(path: &Path) -> Result<WorkspaceConfig, CliError> {
    if !path.exists() {
        return Ok(WorkspaceConfig::default());
    }
    let text = std::fs::read_to_string(path).map_err(|e| {
        CliError::new(
            format!("read config {}: {e}", path.display()),
            ErrorCode::Unknown,
        )
    })?;
    if text.trim().is_empty() {
        return Ok(WorkspaceConfig::default());
    }
    toml::from_str(&text).map_err(|e| {
        CliError::new(
            format!("parse config {}: {e}", path.display()),
            ErrorCode::Unknown,
        )
    })
}

pub fn save_workspace_config(cfg: &WorkspaceConfig) -> Result<PathBuf, CliError> {
    let path = config_path()?;
    save_workspace_config_at(cfg, &path)?;
    Ok(path)
}

pub fn save_workspace_config_at(cfg: &WorkspaceConfig, path: &Path) -> Result<(), CliError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            CliError::new(
                format!("create_dir_all({}): {e}", parent.display()),
                ErrorCode::Unknown,
            )
        })?;
    }
    let body = toml::to_string_pretty(cfg)
        .map_err(|e| CliError::new(format!("serialize config: {e}"), ErrorCode::Unknown))?;
    let final_body = if body.trim().is_empty() {
        "# gdrivescope config\n".to_string()
    } else {
        format!("# gdrivescope config\n\n{body}")
    };
    std::fs::write(path, final_body).map_err(|e| {
        CliError::new(
            format!("write config {}: {e}", path.display()),
            ErrorCode::Unknown,
        )
    })?;
    Ok(())
}

pub fn resolve_folder(cfg: &WorkspaceConfig, name_or_id: &str) -> String {
    cfg.folders
        .get(name_or_id)
        .cloned()
        .unwrap_or_else(|| name_or_id.to_string())
}

pub fn find_root<'a>(cfg: &'a WorkspaceConfig, id: &str) -> Option<&'a ConfigRoot> {
    cfg.roots.iter().find(|r| r.id == id)
}

pub fn upsert_root(cfg: &mut WorkspaceConfig, root: ConfigRoot) {
    if let Some(slot) = cfg.roots.iter_mut().find(|r| r.id == root.id) {
        *slot = root;
    } else {
        cfg.roots.push(root);
    }
}

pub fn remove_root(cfg: &mut WorkspaceConfig, id: &str) -> bool {
    let before = cfg.roots.len();
    cfg.roots.retain(|r| r.id != id);
    cfg.roots.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_through_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut cfg = WorkspaceConfig::default();
        upsert_root(
            &mut cfg,
            ConfigRoot {
                id: "abc".into(),
                label: Some("Inbox".into()),
            },
        );
        cfg.folders.insert("inbox".into(), "abc".into());
        cfg.llm = Some(LlmConfig {
            provider: Some("openai".into()),
            model: Some("gpt-x".into()),
        });
        save_workspace_config_at(&cfg, &path).unwrap();
        let reloaded = load_workspace_config_at(&path).unwrap();
        assert_eq!(reloaded.roots, cfg.roots);
        assert_eq!(
            reloaded.folders.get("inbox").map(String::as_str),
            Some("abc")
        );
        assert_eq!(reloaded.llm.unwrap().provider.as_deref(), Some("openai"));
    }

    #[test]
    fn missing_file_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope.toml");
        let cfg = load_workspace_config_at(&path).unwrap();
        assert!(cfg.roots.is_empty());
        assert!(cfg.folders.is_empty());
    }

    #[test]
    fn upsert_replaces_existing_root_by_id() {
        let mut cfg = WorkspaceConfig::default();
        upsert_root(
            &mut cfg,
            ConfigRoot {
                id: "x".into(),
                label: Some("a".into()),
            },
        );
        upsert_root(
            &mut cfg,
            ConfigRoot {
                id: "x".into(),
                label: Some("b".into()),
            },
        );
        assert_eq!(cfg.roots.len(), 1);
        assert_eq!(cfg.roots[0].label.as_deref(), Some("b"));
    }

    #[test]
    fn resolve_folder_falls_back_to_input() {
        let mut cfg = WorkspaceConfig::default();
        cfg.folders.insert("alias".into(), "real-id".into());
        assert_eq!(resolve_folder(&cfg, "alias"), "real-id");
        assert_eq!(resolve_folder(&cfg, "other"), "other");
    }

    #[test]
    fn remove_root_returns_whether_anything_changed() {
        let mut cfg = WorkspaceConfig::default();
        upsert_root(
            &mut cfg,
            ConfigRoot {
                id: "x".into(),
                label: None,
            },
        );
        assert!(remove_root(&mut cfg, "x"));
        assert!(!remove_root(&mut cfg, "x"));
    }
}
