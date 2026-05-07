use std::path::PathBuf;

use clap::Args;
use serde::Serialize;

use crate::auth::scopes::{ensure_scope, SCOPE_FULL};
use crate::auth::vault::KeyringVault;
use crate::drive::client::DriveClient;
use crate::drive::download::{
    download_to_file, office_export_map, DownloadFormat, DownloadTargetFile,
};
use crate::error::{CliError, ErrorCode};
use crate::formatters::emit;
use crate::graph::store::Store;
use crate::models::{success, ApiResponse};
use crate::utils::db_path;

#[derive(Args, Debug, Clone)]
pub struct DownloadArgs {
    pub id: Option<String>,
    #[arg(short, long)]
    pub output: Option<String>,
    #[arg(long)]
    pub format: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct DownloadOk {
    output_path: String,
    bytes: u64,
    mime_type: String,
}

pub async fn execute(args: DownloadArgs) -> Result<(), CliError> {
    let id = args
        .id
        .ok_or_else(|| CliError::new("download: <id> is required", ErrorCode::MissingArg))?;
    let dest = args
        .output
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let format = match args.format.as_deref() {
        None | Some("auto") => DownloadFormat::Auto,
        Some("raw") => DownloadFormat::Raw,
        Some(other) => {
            return Err(CliError::new(
                format!("download: --format must be 'auto' or 'raw', got '{other}'"),
                ErrorCode::BadArg,
            ));
        }
    };

    let vault = KeyringVault::new();
    ensure_scope(&vault, SCOPE_FULL).await?;
    let client = DriveClient::from_vault(&vault).await?;

    // Look up the node from the store for name + mime; fall back to a Drive
    // probe if it isn't indexed.
    let store = Store::open(&db_path()?)?;
    let target = match store.get_node(&id)? {
        Some(n) => DownloadTargetFile {
            id: n.id,
            name: n.name,
            mime_type: n.mime_type,
        },
        None => {
            let f = client.files_get(&id, "id,name,mimeType").await?;
            DownloadTargetFile {
                id: f.id().unwrap_or(&id).to_string(),
                name: f.name().unwrap_or(&id).to_string(),
                mime_type: f
                    .mime_type()
                    .unwrap_or("application/octet-stream")
                    .to_string(),
            }
        }
    };

    let result = download_to_file(&client, &target, &dest, format, &office_export_map()).await?;

    let resp: ApiResponse<DownloadOk> = success(DownloadOk {
        output_path: result.output_path.display().to_string(),
        bytes: result.bytes,
        mime_type: result.mime_type,
    });
    emit(&resp, |d| {
        format!(
            "Downloaded {} ({} bytes, {}) to {}",
            target_name(&target),
            d.bytes,
            d.mime_type,
            d.output_path,
        )
    });
    Ok(())
}

fn target_name(t: &DownloadTargetFile) -> String {
    if t.name.is_empty() {
        t.id.clone()
    } else {
        t.name.clone()
    }
}
