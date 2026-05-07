//! Anthropic Messages API — tool-use forced output for schema-conformant
//! JSON, plus prompt-caching `cache_control` on the system prompt.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::http::{post_json, Auth, ErrorMapping};
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
    base_url: String,
}

impl AnthropicProvider {
    pub fn new(api_key: impl Into<String>, model: Option<String>) -> Self {
        Self::with_base_url(api_key, model, ANTHROPIC_API.to_string())
    }

    pub fn with_base_url(
        api_key: impl Into<String>,
        model: Option<String>,
        base_url: String,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: api_key.into(),
            model: model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            base_url,
        }
    }
}

fn err_map() -> ErrorMapping {
    ErrorMapping {
        call: ErrorCode::LlmCallFailed,
        parse: ErrorCode::LlmMalformedOutput,
        unreachable: None,
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
        let parsed: MessagesResponse = post_json(
            &self.http,
            &self.base_url,
            Auth::Header("x-api-key", &self.api_key),
            &[("anthropic-version", ANTHROPIC_VERSION)],
            &body,
            "Anthropic",
            &err_map(),
        )
        .await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;

    fn input() -> LlmSummarizeInput {
        LlmSummarizeInput {
            markdown: "doc body".into(),
            filename: "f".into(),
            path: "p".into(),
            mime_type: "text/plain".into(),
        }
    }

    #[tokio::test]
    async fn happy_path_extracts_tool_use_input() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"content":[{"type":"tool_use","name":"record_summary",
                "input":{"summary":"S","classification":"other","key_topics":["t"]}}]}"#,
            )
            .create_async()
            .await;
        let p = AnthropicProvider::with_base_url("test-key", None, srv.url());
        let out = p.summarize(&input()).await.unwrap();
        assert_eq!(out.summary, "S");
        assert_eq!(out.key_topics, vec!["t"]);
    }

    #[tokio::test]
    async fn http_error_maps_to_llm_call_failed() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/")
            .with_status(401)
            .with_body("unauthorized")
            .create_async()
            .await;
        let p = AnthropicProvider::with_base_url("bad", None, srv.url());
        let err = p.summarize(&input()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmCallFailed);
        assert!(err.message.contains("401"));
    }

    #[tokio::test]
    async fn missing_tool_use_block_errors() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"content":[{"type":"text","text":"hi"}]}"#)
            .create_async()
            .await;
        let p = AnthropicProvider::with_base_url("k", None, srv.url());
        let err = p.summarize(&input()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmMalformedOutput);
    }
}
