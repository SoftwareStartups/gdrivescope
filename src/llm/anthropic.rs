//! Anthropic Messages API — tool-use forced output for schema-conformant
//! JSON, plus prompt-caching `cache_control` on the system prompt. Also
//! exposes the async [Message Batches API] for 50%-discounted bulk
//! summarization.
//!
//! [Message Batches API]: https://docs.claude.com/en/api/creating-message-batches

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::batch::{make_custom_id, run_batch, BatchOps, PollState};
use super::http::{post_json, Auth, LLM_BATCH_SUBMIT_ERROR_MAP, LLM_CALL_ERROR_MAP};
use super::prompts::{summary_user, SUMMARY_SYSTEM};
use super::provider::{BatchOptions, LlmProvider, LlmSummarizeInput, LlmSummary};
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

#[derive(Debug, Deserialize)]
struct BatchCreateResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
struct BatchStatusResponse {
    processing_status: String,
    #[serde(default)]
    results_url: Option<String>,
}

pub struct AnthropicProvider {
    http: reqwest::Client,
    api_key: String,
    model: String,
    base_url: String,
}

pub struct AnthropicProviderOptions {
    pub api_key: String,
    pub model: Option<String>,
    /// Override the Messages API endpoint. `None` uses Anthropic's default.
    pub base_url: Option<String>,
}

impl AnthropicProvider {
    pub fn new(opts: AnthropicProviderOptions) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: opts.api_key,
            model: opts.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            base_url: opts.base_url.unwrap_or_else(|| ANTHROPIC_API.to_string()),
        }
    }

    /// JSON value for one Messages-API request — shared between the
    /// synchronous `summarize` path and the batch `params` field.
    fn request_params(&self, input: &LlmSummarizeInput) -> Value {
        json!({
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
        })
    }
}

/// Pull the `record_summary` tool_use input out of a Messages response and
/// hand it to the shared validator.
fn extract_summary(content: Vec<ContentBlock>) -> Result<LlmSummary, CliError> {
    let tool_input = content.into_iter().find_map(|b| match b {
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

#[async_trait]
impl LlmProvider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    fn supports_batch(&self) -> bool {
        true
    }

    async fn summarize(&self, input: &LlmSummarizeInput) -> Result<LlmSummary, CliError> {
        let body = self.request_params(input);
        let parsed: MessagesResponse = post_json(
            &self.http,
            &self.base_url,
            Auth::Header("x-api-key", &self.api_key),
            &[("anthropic-version", ANTHROPIC_VERSION)],
            &body,
            "Anthropic",
            &LLM_CALL_ERROR_MAP,
        )
        .await?;
        extract_summary(parsed.content)
    }

    async fn summarize_batch(
        &self,
        inputs: &[LlmSummarizeInput],
        opts: &BatchOptions,
    ) -> Result<Vec<Result<LlmSummary, CliError>>, CliError> {
        run_batch(self, inputs, opts).await
    }
}

#[async_trait]
impl BatchOps for AnthropicProvider {
    type SubmitHandle = String;
    type FetchHandle = String;

    fn label(&self) -> &'static str {
        "Anthropic"
    }

    async fn submit(&self, inputs: &[LlmSummarizeInput]) -> Result<Self::SubmitHandle, CliError> {
        let requests: Vec<Value> = inputs
            .iter()
            .enumerate()
            .map(|(i, input)| {
                json!({
                    "custom_id": make_custom_id(i),
                    "params": self.request_params(input),
                })
            })
            .collect();
        let submit_body = json!({ "requests": requests });
        let submit_url = format!("{}/batches", self.base_url);
        let created: BatchCreateResponse = post_json(
            &self.http,
            &submit_url,
            Auth::Header("x-api-key", &self.api_key),
            &[("anthropic-version", ANTHROPIC_VERSION)],
            &submit_body,
            "Anthropic batch",
            &LLM_BATCH_SUBMIT_ERROR_MAP,
        )
        .await?;
        Ok(created.id)
    }

    async fn poll(
        &self,
        batch_id: &Self::SubmitHandle,
    ) -> Result<PollState<Self::FetchHandle>, CliError> {
        let status_url = format!("{}/batches/{batch_id}", self.base_url);
        let resp = self
            .http
            .get(&status_url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .send()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("Anthropic batch poll failed: {e}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Ok(PollState::Failed(CliError::new(
                format!("Anthropic batch poll failed (status {status}): {text}"),
                ErrorCode::LlmBatchPollFailed,
            )));
        }
        let body: BatchStatusResponse = resp.json().await.map_err(|e| {
            CliError::new(
                format!("Anthropic batch poll parse failed: {e}"),
                ErrorCode::LlmBatchPollFailed,
            )
        })?;
        if body.processing_status == "ended" {
            let url = body.results_url.ok_or_else(|| {
                CliError::new(
                    "Anthropic batch ended without a results_url",
                    ErrorCode::LlmBatchPollFailed,
                )
            })?;
            Ok(PollState::Done(url))
        } else {
            Ok(PollState::InProgress)
        }
    }

    async fn fetch(&self, results_url: &Self::FetchHandle) -> Result<String, CliError> {
        self.http
            .get(results_url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| {
                CliError::new(
                    format!("Anthropic batch results fetch failed: {e}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })?
            .text()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("Anthropic batch results read failed: {e}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })
    }

    fn parse_line(&self, v: &Value) -> Result<LlmSummary, CliError> {
        let result = v.get("result").ok_or_else(|| {
            CliError::new(
                "Anthropic batch result line missing result",
                ErrorCode::LlmBatchPollFailed,
            )
        })?;
        let kind = result.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match kind {
            "succeeded" => {
                let content = result
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .cloned()
                    .ok_or_else(|| {
                        CliError::new(
                            "Anthropic batch succeeded result missing message.content",
                            ErrorCode::LlmMalformedOutput,
                        )
                    })?;
                let blocks: Vec<ContentBlock> = serde_json::from_value(content).map_err(|e| {
                    CliError::new(
                        format!("Anthropic batch content parse failed: {e}"),
                        ErrorCode::LlmMalformedOutput,
                    )
                })?;
                extract_summary(blocks)
            }
            "errored" | "canceled" | "expired" => {
                let detail = result
                    .get("error")
                    .and_then(|e| serde_json::to_string(e).ok())
                    .unwrap_or_else(|| kind.to_string());
                Err(CliError::new(
                    format!("Anthropic batch result {kind}: {detail}"),
                    ErrorCode::LlmCallFailed,
                ))
            }
            other => Err(CliError::new(
                format!("Anthropic batch returned unknown result type: {other}"),
                ErrorCode::LlmMalformedOutput,
            )),
        }
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

    fn test_opts(api_key: &str, base_url: String) -> AnthropicProviderOptions {
        AnthropicProviderOptions {
            api_key: api_key.into(),
            model: None,
            base_url: Some(base_url),
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
        let p = AnthropicProvider::new(test_opts("test-key", srv.url()));
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
        let p = AnthropicProvider::new(test_opts("bad", srv.url()));
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
        let p = AnthropicProvider::new(test_opts("k", srv.url()));
        let err = p.summarize(&input()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmMalformedOutput);
    }

    fn fast_batch_opts() -> BatchOptions {
        BatchOptions {
            timeout: std::time::Duration::from_secs(5),
            poll_interval: std::time::Duration::from_millis(1),
        }
    }

    #[tokio::test]
    async fn batch_happy_path_returns_per_item_summaries() {
        let mut srv = Server::new_async().await;
        let results_url = format!("{}/results.jsonl", srv.url());
        let _submit = srv
            .mock("POST", "/batches")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"id":"msgbatch_test","type":"message_batch","processing_status":"in_progress"}"#,
            )
            .create_async()
            .await;
        let _poll = srv
            .mock("GET", "/batches/msgbatch_test")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(format!(
                r#"{{"id":"msgbatch_test","processing_status":"ended","results_url":"{results_url}"}}"#,
            ))
            .create_async()
            .await;
        let _results = srv
            .mock("GET", "/results.jsonl")
            .with_status(200)
            .with_body(concat!(
                r#"{"custom_id":"i1","result":{"type":"succeeded","message":{"content":[{"type":"tool_use","name":"record_summary","input":{"summary":"S1","classification":"financial","key_topics":["x"]}}]}}}"#,
                "\n",
                r#"{"custom_id":"i0","result":{"type":"succeeded","message":{"content":[{"type":"tool_use","name":"record_summary","input":{"summary":"S0","classification":"other","key_topics":[]}}]}}}"#,
                "\n",
            ))
            .create_async()
            .await;

        let p = AnthropicProvider::new(test_opts("k", srv.url()));
        let inputs = vec![input(), input()];
        let results = p
            .summarize_batch(&inputs, &fast_batch_opts())
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        // Re-ordered JSONL must still produce results in input order via custom_id.
        assert_eq!(results[0].as_ref().unwrap().summary, "S0");
        assert_eq!(results[1].as_ref().unwrap().summary, "S1");
    }

    #[tokio::test]
    async fn batch_partial_failure_surfaces_per_item_error() {
        let mut srv = Server::new_async().await;
        let results_url = format!("{}/results.jsonl", srv.url());
        let _submit = srv
            .mock("POST", "/batches")
            .with_status(200)
            .with_body(r#"{"id":"msgbatch_x","processing_status":"in_progress"}"#)
            .create_async()
            .await;
        let _poll = srv
            .mock("GET", "/batches/msgbatch_x")
            .with_status(200)
            .with_body(format!(
                r#"{{"id":"msgbatch_x","processing_status":"ended","results_url":"{results_url}"}}"#,
            ))
            .create_async()
            .await;
        let _results = srv
            .mock("GET", "/results.jsonl")
            .with_status(200)
            .with_body(concat!(
                r#"{"custom_id":"i0","result":{"type":"succeeded","message":{"content":[{"type":"tool_use","name":"record_summary","input":{"summary":"S","classification":"other","key_topics":[]}}]}}}"#,
                "\n",
                r#"{"custom_id":"i1","result":{"type":"errored","error":{"type":"invalid_request_error","message":"oops"}}}"#,
                "\n",
            ))
            .create_async()
            .await;

        let p = AnthropicProvider::new(test_opts("k", srv.url()));
        let inputs = vec![input(), input()];
        let results = p
            .summarize_batch(&inputs, &fast_batch_opts())
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].as_ref().unwrap().summary, "S");
        let err = results[1].as_ref().unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmCallFailed);
        assert!(err.message.contains("errored"));
    }

    #[tokio::test]
    async fn batch_poll_timeout_errors() {
        let mut srv = Server::new_async().await;
        let _submit = srv
            .mock("POST", "/batches")
            .with_status(200)
            .with_body(r#"{"id":"msgbatch_y","processing_status":"in_progress"}"#)
            .create_async()
            .await;
        let _poll = srv
            .mock("GET", "/batches/msgbatch_y")
            .with_status(200)
            .with_body(r#"{"id":"msgbatch_y","processing_status":"in_progress"}"#)
            .expect_at_least(1)
            .create_async()
            .await;

        let p = AnthropicProvider::new(test_opts("k", srv.url()));
        let opts = BatchOptions {
            timeout: std::time::Duration::from_millis(20),
            poll_interval: std::time::Duration::from_millis(5),
        };
        let err = p.summarize_batch(&[input()], &opts).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmBatchTimeout);
    }

    #[tokio::test]
    async fn supports_batch_is_true() {
        let p = AnthropicProvider::new(AnthropicProviderOptions {
            api_key: "k".into(),
            model: None,
            base_url: None,
        });
        assert!(p.supports_batch());
    }
}
