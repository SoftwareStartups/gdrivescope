use std::path::PathBuf;

use clap::Args;
use serde::Serialize;

use crate::auth::scopes::{ensure_scope, SCOPE_FULL};
use crate::auth::vault::KeyringVault;
use crate::drive::client::DriveClient;
use crate::drive::download::{
    download_to_file, download_tree, office_export_map, DownloadFormat, DownloadTargetFile,
    TreeDownloadFile, TreeDownloadOptions, TreeDownloadResult,
};
use crate::error::{CliError, ErrorCode};
use crate::extract::{extract_to_markdown, should_extract, ExtractOptions};
use crate::formatters::emit;
use crate::graph::store::Store;
use crate::models::{success, ApiResponse};
use crate::utils::db_path;

const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

#[derive(Args, Debug, Clone)]
pub struct DownloadArgs {
    pub id: Option<String>,
    #[arg(short, long)]
    pub output: Option<String>,
    #[arg(long)]
    pub format: Option<String>,
    /// Also write a `<filename>.md` markdown sidecar for every extractable
    /// file. Defaults to off.
    #[arg(long)]
    pub convert: bool,
    /// Skip *conversion* of files larger than this many bytes. Default:
    /// no cap (the file is downloaded in full regardless).
    #[arg(long = "max-size")]
    pub max_size: Option<u64>,
    /// Truncate PDF conversion to first N pages. Default: full PDF.
    #[arg(long = "max-pdf-pages")]
    pub max_pdf_pages: Option<usize>,
    /// Concurrency cap for tree downloads (clamped to 1..=15, default 4).
    /// Ignored when downloading a single file.
    #[arg(long)]
    pub concurrency: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct SingleDownloadOk {
    output_path: String,
    bytes: u64,
    mime_type: String,
    converted_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct TreeDownloadOk {
    scope_id: String,
    scope_name: String,
    files: Vec<TreeFileRow>,
    failures: Vec<TreeFailureRow>,
    bytes_total: u64,
    converted: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct TreeFileRow {
    id: String,
    name: String,
    path: String,
    bytes: u64,
    converted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct TreeFailureRow {
    id: String,
    name: String,
    path: Option<String>,
    message: String,
    stage: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum DownloadData {
    Single(SingleDownloadOk),
    Tree(TreeDownloadOk),
}

pub async fn execute(args: DownloadArgs) -> Result<(), CliError> {
    let id = args
        .id
        .clone()
        .ok_or_else(|| CliError::new("download: <id> is required", ErrorCode::MissingArg))?;
    let dest = args
        .output
        .as_deref()
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

    // Resolve mime first — we dispatch differently for folders vs single files.
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

    if target.mime_type == FOLDER_MIME {
        run_tree(client, &target, dest, format, &args).await
    } else {
        run_single(client, &target, dest, format, &args).await
    }
}

async fn run_single(
    client: DriveClient,
    target: &DownloadTargetFile,
    dest: PathBuf,
    format: DownloadFormat,
    args: &DownloadArgs,
) -> Result<(), CliError> {
    let result = download_to_file(&client, target, &dest, format, &office_export_map()).await?;

    let mut converted_path: Option<String> = None;
    if args.convert && should_extract(&result.mime_type) {
        let too_large = args.max_size.map(|cap| result.bytes > cap).unwrap_or(false);
        if !too_large {
            let bytes = tokio::fs::read(&result.output_path).await.map_err(|e| {
                CliError::new(
                    format!("read {} for convert: {e}", result.output_path.display()),
                    ErrorCode::IoFailed,
                )
            })?;
            let md = extract_to_markdown(
                bytes,
                &result.mime_type,
                ExtractOptions {
                    max_pdf_pages: args.max_pdf_pages,
                },
            )
            .await?;
            let mut sidecar_os = result.output_path.as_os_str().to_os_string();
            sidecar_os.push(".md");
            let sidecar = PathBuf::from(sidecar_os);
            tokio::fs::write(&sidecar, md.as_bytes())
                .await
                .map_err(|e| CliError::new(format!("write sidecar: {e}"), ErrorCode::IoFailed))?;
            converted_path = Some(sidecar.display().to_string());
        }
    }

    let resp: ApiResponse<DownloadData> = success(DownloadData::Single(SingleDownloadOk {
        output_path: result.output_path.display().to_string(),
        bytes: result.bytes,
        mime_type: result.mime_type.clone(),
        converted_path: converted_path.clone(),
    }));
    let display_name = if target.name.is_empty() {
        target.id.clone()
    } else {
        target.name.clone()
    };
    emit(&resp, move |d| match d {
        DownloadData::Single(s) => {
            let mut out = format!(
                "Downloaded {} ({} bytes, {}) to {}",
                display_name, s.bytes, s.mime_type, s.output_path,
            );
            if let Some(cp) = &s.converted_path {
                out.push_str(&format!("\nConverted to markdown: {cp}"));
            }
            out
        }
        DownloadData::Tree(_) => unreachable!("Single render branch on Tree variant"),
    });
    Ok(())
}

async fn run_tree(
    client: DriveClient,
    target: &DownloadTargetFile,
    dest: PathBuf,
    format: DownloadFormat,
    args: &DownloadArgs,
) -> Result<(), CliError> {
    let opts = TreeDownloadOptions {
        format,
        concurrency: args.concurrency,
        convert: args.convert,
        max_size_bytes: args.max_size,
        max_pdf_pages: args.max_pdf_pages,
    };
    let result: TreeDownloadResult = download_tree(&client, &target.id, &dest, opts).await?;

    let converted = result
        .files
        .iter()
        .filter(|f: &&TreeDownloadFile| f.converted)
        .count() as u64;

    let resp_data = DownloadData::Tree(TreeDownloadOk {
        scope_id: result.scope_id.clone(),
        scope_name: result.scope_name.clone(),
        files: result
            .files
            .iter()
            .map(|f| TreeFileRow {
                id: f.id.clone(),
                name: f.name.clone(),
                path: f.path.display().to_string(),
                bytes: f.bytes,
                converted: f.converted,
            })
            .collect(),
        failures: result
            .failures
            .iter()
            .map(|f| TreeFailureRow {
                id: f.id.clone(),
                name: f.name.clone(),
                path: f.path.as_ref().map(|p| p.display().to_string()),
                message: f.message.clone(),
                stage: match f.stage {
                    crate::drive::download::TreeDownloadStage::Download => "download".to_string(),
                    crate::drive::download::TreeDownloadStage::Convert => "convert".to_string(),
                },
            })
            .collect(),
        bytes_total: result.bytes_total,
        converted,
    });
    let resp: ApiResponse<DownloadData> = success(resp_data);
    let dest_display = dest.display().to_string();
    let convert_requested = args.convert;
    emit(&resp, move |d| match d {
        DownloadData::Tree(t) => {
            let mut out = format!(
                "Downloaded {} file(s) ({} bytes) under {} to {}",
                t.files.len(),
                t.bytes_total,
                t.scope_name,
                dest_display,
            );
            if convert_requested {
                out.push_str(&format!(
                    "\n  converted: {}/{} to markdown",
                    t.converted,
                    t.files.len(),
                ));
            }
            if !t.failures.is_empty() {
                out.push_str(&format!("\n  failures:  {} (see above)", t.failures.len()));
            }
            out
        }
        DownloadData::Single(_) => unreachable!("Tree render branch on Single variant"),
    });
    Ok(())
}
