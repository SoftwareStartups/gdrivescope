use clap::{Parser, Subcommand};

use crate::config::{load_workspace_config, WorkspaceConfig};
use crate::error::{CliError, ErrorCode};
use crate::formatters::{emit, set_json_mode};
use crate::graph::hydrate::hydrate_graph;
use crate::graph::model::DriveGraph;
use crate::graph::store::Store;
use crate::models::{to_response, ApiResponse};
use crate::utils::db_path;

pub mod config;
pub mod download;
pub mod index;
pub mod list;
pub mod login;
pub mod logout;
pub mod ollama;
pub mod search;
pub mod show;

/// Standard bootstrap for read-only commands that need the persistent
/// store, the in-memory graph, and the workspace config. Config errors
/// are silently coerced to defaults — commands that need an explicit
/// config (the `config` subcommand itself) should call
/// `crate::config::load_workspace_config` directly.
pub struct CommandContext {
    pub store: Store,
    pub graph: DriveGraph,
    pub config: WorkspaceConfig,
}

impl CommandContext {
    pub fn open() -> Result<Self, CliError> {
        let config = load_workspace_config().unwrap_or_default();
        let store = Store::open(&db_path()?)?;
        let graph = hydrate_graph(&store)?;
        Ok(Self {
            store,
            graph,
            config,
        })
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "gdrivescope",
    version,
    about = "Google Drive indexing, search, and download CLI",
    long_about = None,
    disable_help_subcommand = true,
)]
struct Cli {
    /// Emit structured JSON responses
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Authorize with Google Drive (OAuth loopback + PKCE)
    Login(login::LoginArgs),
    /// Clear stored credentials
    Logout,
    /// Build or refresh the persistent Drive graph
    Index(index::IndexArgs),
    /// List entries under a folder from the indexed graph
    List(list::ListArgs),
    /// Show a single node from the indexed graph
    Show(show::ShowArgs),
    /// Search the indexed graph by name or embedding
    Search(search::SearchArgs),
    /// Download a file from Drive
    Download(download::DownloadArgs),
    /// Workspace config (show, list-roots, add-root, remove-root)
    Config {
        #[command(subcommand)]
        cmd: config::ConfigCmd,
    },
    /// Ollama setup helper
    Ollama {
        #[command(subcommand)]
        cmd: ollama::OllamaCmd,
    },
}

/// Top-level entry. Returns the process exit code.
pub async fn run() -> i32 {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            // clap handles --help / --version with exit code 0; everything
            // else (parse errors) is exit code 2 with stderr already written.
            e.print().ok();
            return if e.use_stderr() { 2 } else { 0 };
        }
    };

    set_json_mode(cli.json);

    let result: Result<(), CliError> = match cli.cmd {
        Cmd::Login(args) => login::execute(args).await,
        Cmd::Logout => logout::execute().await,
        Cmd::Index(args) => index::execute(args).await,
        Cmd::List(args) => list::execute(args).await,
        Cmd::Show(args) => show::execute(args).await,
        Cmd::Search(args) => search::execute(args).await,
        Cmd::Download(args) => download::execute(args).await,
        Cmd::Config { cmd } => config::execute(cmd).await,
        Cmd::Ollama { cmd } => ollama::execute(cmd).await,
    };

    match result {
        Ok(()) => 0,
        Err(err) => {
            let resp: ApiResponse<()> = to_response(&err);
            emit(&resp, |_| String::new());
            // Exit code 2 for usage errors, 1 for everything else.
            match err.code {
                ErrorCode::Usage
                | ErrorCode::UnknownCommand
                | ErrorCode::MissingArg
                | ErrorCode::BadArg => 2,
                _ => 1,
            }
        }
    }
}
