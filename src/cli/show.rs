use clap::Args;
use serde::Serialize;

use crate::error::{CliError, ErrorCode};
use crate::formatters::emit;
use crate::graph::model::Node;
use crate::graph::paths::node_path;
use crate::models::{success, ApiResponse};

use super::CommandContext;

#[derive(Args, Debug, Clone)]
pub struct ShowArgs {
    pub id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct ShowData {
    #[serde(flatten)]
    node: Node,
    path: String,
}

pub async fn execute(args: ShowArgs) -> Result<(), CliError> {
    let id = args
        .id
        .ok_or_else(|| CliError::new("show: <id> is required", ErrorCode::MissingArg))?;
    let ctx = CommandContext::open()?;
    let node = ctx
        .store
        .get_node(&id)?
        .ok_or_else(|| CliError::new(format!("Node not found: {id}"), ErrorCode::NodeNotFound))?;
    let path = node_path(&ctx.graph, &id);
    let data = ShowData { node, path };
    let resp: ApiResponse<ShowData> = success(data);
    emit(&resp, |d| {
        let mut lines = vec![
            format!("id:           {}", d.node.id),
            format!("name:         {}", d.node.name),
            format!("mime:         {}", d.node.mime_type),
            format!("path:         {}", d.path),
        ];
        if let Some(s) = &d.node.summary {
            lines.push(format!("summary:      {s}"));
        }
        if let Some(c) = &d.node.classification {
            lines.push(format!("class:        {c}"));
        }
        if let Some(k) = &d.node.key_topics {
            lines.push(format!("key_topics:   {k}"));
        }
        if let Some(li) = &d.node.last_indexed {
            lines.push(format!("last_indexed: {li}"));
        }
        if let Some(le) = &d.node.last_error {
            lines.push(format!("last_error:   {le}"));
        }
        lines.join("\n")
    });
    Ok(())
}
