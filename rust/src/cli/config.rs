use clap::Subcommand;
use serde::Serialize;

use crate::config::{
    config_path, find_root, load_workspace_config, remove_root, save_workspace_config, upsert_root,
    ConfigRoot, WorkspaceConfig,
};
use crate::error::{CliError, ErrorCode};
use crate::formatters::emit;
use crate::models::{success, ApiResponse};

#[derive(Subcommand, Debug, Clone)]
pub enum ConfigCmd {
    /// Print the workspace config
    Show,
    /// List configured root folders
    ListRoots,
    /// Persist a Drive folder as a root
    AddRoot {
        id: String,
        #[arg(long)]
        label: Option<String>,
    },
    /// Remove a configured root
    RemoveRoot { id: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShowOk {
    config_path: String,
    config: WorkspaceConfig,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RootsOk {
    roots: Vec<ConfigRoot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedOk {
    config_path: String,
    changed: bool,
    root: Option<ConfigRoot>,
}

pub async fn execute(cmd: ConfigCmd) -> Result<(), CliError> {
    match cmd {
        ConfigCmd::Show => show().await,
        ConfigCmd::ListRoots => list_roots().await,
        ConfigCmd::AddRoot { id, label } => add_root(id, label).await,
        ConfigCmd::RemoveRoot { id } => remove_root_cmd(id).await,
    }
}

async fn show() -> Result<(), CliError> {
    let cfg = load_workspace_config()?;
    let path = config_path()?.display().to_string();
    let resp: ApiResponse<ShowOk> = success(ShowOk {
        config_path: path,
        config: cfg,
    });
    emit(&resp, |d| {
        toml::to_string_pretty(&d.config).unwrap_or_else(|e| format!("(serialize error: {e})"))
    });
    Ok(())
}

async fn list_roots() -> Result<(), CliError> {
    let cfg = load_workspace_config()?;
    let resp: ApiResponse<RootsOk> = success(RootsOk { roots: cfg.roots });
    emit(&resp, |d| {
        if d.roots.is_empty() {
            "No roots configured.".to_string()
        } else {
            d.roots
                .iter()
                .map(|r| match &r.label {
                    Some(l) => format!("{}\t{l}", r.id),
                    None => r.id.clone(),
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    });
    Ok(())
}

async fn add_root(id: String, label: Option<String>) -> Result<(), CliError> {
    if id.is_empty() {
        return Err(CliError::new(
            "add-root: <id> cannot be empty",
            ErrorCode::BadArg,
        ));
    }
    let mut cfg = load_workspace_config()?;
    let root = ConfigRoot {
        id: id.clone(),
        label,
    };
    let already_present = find_root(&cfg, &id).cloned();
    upsert_root(&mut cfg, root.clone());
    let path = save_workspace_config(&cfg)?;
    let resp: ApiResponse<ChangedOk> = success(ChangedOk {
        config_path: path.display().to_string(),
        changed: already_present.as_ref() != Some(&root),
        root: Some(root.clone()),
    });
    emit(&resp, |d| {
        format!(
            "{} root {}: {}",
            if d.changed { "Saved" } else { "Unchanged" },
            d.root.as_ref().map(|r| r.id.as_str()).unwrap_or(""),
            d.config_path,
        )
    });
    Ok(())
}

async fn remove_root_cmd(id: String) -> Result<(), CliError> {
    let mut cfg = load_workspace_config()?;
    let removed_root = find_root(&cfg, &id).cloned();
    let changed = remove_root(&mut cfg, &id);
    let path = save_workspace_config(&cfg)?;
    let resp: ApiResponse<ChangedOk> = success(ChangedOk {
        config_path: path.display().to_string(),
        changed,
        root: removed_root,
    });
    emit(&resp, |d| {
        if d.changed {
            format!("Removed root {id}: {}", d.config_path)
        } else {
            format!("No root with id {id}")
        }
    });
    Ok(())
}
