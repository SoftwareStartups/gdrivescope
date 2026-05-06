//! Anthropic Messages API. Ported from `src/llm/anthropic.ts`.
//! Uses tool-use forced output for schema-conformant JSON, plus the
//! prompt-caching `cache_control` block on the system prompt.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::prompts::{summary_user, SUMMARY_SYSTEM};
use super::provider::{LlmProvider, LlmSummarizeInput, LlmSummary};
use super::schema::llm_summary_schema;
use super::summary_parse::validate_raw_summary;
use crate::error::{CliError, ErrorCode};

const ANTHROPIC_API: &str = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlock {
    ToolUse {
        #[allow(dead_code)]
        name: String,
        input: serde_json::Value,
    },
    #[serde(other)]
    Other,
}

pub struct AnthropicProvider {
    http: reqwest::Client,
    api_key: String,
    model: String,
}

impl AnthropicProvider {
    pub fn new(api_key: impl Into<String>, model: Option<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: api_key.into(),
            model: model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        }
    }
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    async fn summarize(&self, input: &LlmSummarizeInput) -> Result<LlmSummary, CliError> {
        let body = json!({
            "model": &self.model,
            "max_tokens": 1024,
            "system": [{
                "type": "text",
                "text": SUMMARY_SYSTEM,
                "cache_control": { "type": "ephemeral" },
            }],
            "tools": [{
                "name": "record_summary",
                "description": "Record a structured summary of the document.",
                "input_schema": llm_summary_schema(),
            }],
            "tool_choice": { "type": "tool", "name": "record_summary" },
            "messages": [{
                "role": "user",
                "content": summary_user(&input.filename, &input.path, &input.markdown),
            }],
        });
        let resp = self
            .http
            .post(ANTHROPIC_API)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("Anthropic call failed: {e}"),
                    ErrorCode::LlmCallFailed,
                )
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(CliError::new(
                format!("Anthropic call failed (status {status}): {text}"),
                ErrorCode::LlmCallFailed,
            ));
        }
        let parsed: MessagesResponse = resp.json().await.map_err(|e| {
            CliError::new(
                format!("Anthropic parse failed: {e}"),
                ErrorCode::LlmMalformedOutput,
            )
        })?;
        let tool_input = parsed.content.into_iter().find_map(|b| match b {
            ContentBlock::ToolUse { input, .. } => Some(input),
            _ => None,
        });
        let raw = tool_input.ok_or_else(|| {
            CliError::new(
                "Anthropic did not return a tool_use block",
                ErrorCode::LlmMalformedOutput,
            )
        })?;
        validate_raw_summary("Anthropic", &raw)
    }
}
