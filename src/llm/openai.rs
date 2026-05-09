//! OpenAI Chat Completions with strict json_schema response_format.
//! Also exposes the [Batch API] for 50%-discounted bulk summarization.
//!
//! [Batch API]: https://platform.openai.com/docs/api-reference/batch

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

const OPENAI_API_ROOT: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-5.4-nano";

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Debug, Deserialize)]
struct Message {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileUploadResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
struct BatchObject {
    #[serde(default)]
    status: String,
    #[serde(default)]
    output_file_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BatchCreateResponse {
    id: String,
}

pub struct OpenaiProvider {
    http: reqwest::Client,
    api_key: String,
    model: String,
    /// API root (e.g. `https://api.openai.com/v1`). Chat / files / batches
    /// endpoints are derived by appending the path.
    api_root: String,
}

pub struct OpenaiProviderOptions {
    pub api_key: String,
    pub model: Option<String>,
    /// Override the API root. `None` uses OpenAI's default.
    pub api_root: Option<String>,
}

impl OpenaiProvider {
    pub fn new(opts: OpenaiProviderOptions) -> Self {
        let api_root = opts
            .api_root
            .unwrap_or_else(|| OPENAI_API_ROOT.to_string())
            .trim_end_matches('/')
            .to_string();
        Self {
            http: reqwest::Client::new(),
            api_key: opts.api_key,
            model: opts.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            api_root,
        }
    }

    fn chat_body(&self, input: &LlmSummarizeInput) -> Value {
        json!({
            "model": &self.model,
            "messages": [
                { "role": "system", "content": SUMMARY_SYSTEM },
                { "role": "user", "content": summary_user(&input.filename, &input.path, &input.markdown) },
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "LlmSummary",
                    "schema": llm_summary_schema(),
                    "strict": true,
                }
            }
        })
    }
}

/// Parse a chat completions message content (raw JSON string returned by
/// the model under strict json_schema) into an `LlmSummary`.
fn parse_chat_content(label: &str, content: &str) -> Result<LlmSummary, CliError> {
    let parsed: Value = serde_json::from_str(content).map_err(|e| {
        CliError::new(
            format!("{label} returned invalid JSON: {e}"),
            ErrorCode::LlmMalformedOutput,
        )
    })?;
    validate_raw_summary(label, &parsed)
}

#[async_trait]
impl LlmProvider for OpenaiProvider {
    fn name(&self) -> &str {
        "openai"
    }

    fn supports_batch(&self) -> bool {
        true
    }

    async fn summarize(&self, input: &LlmSummarizeInput) -> Result<LlmSummary, CliError> {
        let url = format!("{}/chat/completions", self.api_root);
        let chat: ChatResponse = post_json(
            &self.http,
            &url,
            Auth::Bearer(&self.api_key),
            &[],
            &self.chat_body(input),
            "OpenAI",
            &LLM_CALL_ERROR_MAP,
        )
        .await?;
        let text = chat
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .ok_or_else(|| {
                CliError::new(
                    "OpenAI returned empty content",
                    ErrorCode::LlmMalformedOutput,
                )
            })?;
        parse_chat_content("OpenAI", &text)
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
impl BatchOps for OpenaiProvider {
    type SubmitHandle = String;
    type FetchHandle = String;

    fn label(&self) -> &'static str {
        "OpenAI"
    }

    async fn submit(&self, inputs: &[LlmSummarizeInput]) -> Result<Self::SubmitHandle, CliError> {
        let mut jsonl = String::new();
        for (i, input) in inputs.iter().enumerate() {
            let line = json!({
                "custom_id": make_custom_id(i),
                "method": "POST",
                "url": "/v1/chat/completions",
                "body": self.chat_body(input),
            });
            jsonl.push_str(&serde_json::to_string(&line).map_err(|e| {
                CliError::new(
                    format!("OpenAI batch JSONL build failed: {e}"),
                    ErrorCode::LlmBatchSubmitFailed,
                )
            })?);
            jsonl.push('\n');
        }

        let files_url = format!("{}/files", self.api_root);
        let form = reqwest::multipart::Form::new()
            .text("purpose", "batch")
            .part(
                "file",
                reqwest::multipart::Part::bytes(jsonl.into_bytes())
                    .file_name("batch_input.jsonl")
                    .mime_str("application/jsonl")
                    .map_err(|e| {
                        CliError::new(
                            format!("OpenAI batch multipart build failed: {e}"),
                            ErrorCode::LlmBatchSubmitFailed,
                        )
                    })?,
            );
        let upload_resp = self
            .http
            .post(&files_url)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("OpenAI batch upload failed: {e}"),
                    ErrorCode::LlmBatchSubmitFailed,
                )
            })?;
        if !upload_resp.status().is_success() {
            let status = upload_resp.status();
            let text = upload_resp.text().await.unwrap_or_default();
            return Err(CliError::new(
                format!("OpenAI batch upload failed (status {status}): {text}"),
                ErrorCode::LlmBatchSubmitFailed,
            ));
        }
        let uploaded: FileUploadResponse = upload_resp.json().await.map_err(|e| {
            CliError::new(
                format!("OpenAI batch upload parse failed: {e}"),
                ErrorCode::LlmBatchSubmitFailed,
            )
        })?;

        let create_url = format!("{}/batches", self.api_root);
        let created: BatchCreateResponse = post_json(
            &self.http,
            &create_url,
            Auth::Bearer(&self.api_key),
            &[],
            &json!({
                "input_file_id": uploaded.id,
                "endpoint": "/v1/chat/completions",
                "completion_window": "24h",
            }),
            "OpenAI batch",
            &LLM_BATCH_SUBMIT_ERROR_MAP,
        )
        .await?;
        Ok(created.id)
    }

    async fn poll(
        &self,
        batch_id: &Self::SubmitHandle,
    ) -> Result<PollState<Self::FetchHandle>, CliError> {
        let status_url = format!("{}/batches/{batch_id}", self.api_root);
        let resp = self
            .http
            .get(&status_url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("OpenAI batch poll failed: {e}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Ok(PollState::Failed(CliError::new(
                format!("OpenAI batch poll failed (status {status}): {text}"),
                ErrorCode::LlmBatchPollFailed,
            )));
        }
        let body: BatchObject = resp.json().await.map_err(|e| {
            CliError::new(
                format!("OpenAI batch poll parse failed: {e}"),
                ErrorCode::LlmBatchPollFailed,
            )
        })?;
        match body.status.as_str() {
            "completed" => {
                let output_id = body.output_file_id.ok_or_else(|| {
                    CliError::new(
                        "OpenAI batch completed without output_file_id",
                        ErrorCode::LlmBatchPollFailed,
                    )
                })?;
                Ok(PollState::Done(output_id))
            }
            "failed" | "expired" | "cancelled" => Ok(PollState::Failed(CliError::new(
                format!("OpenAI batch ended with status {}", body.status),
                ErrorCode::LlmBatchSubmitFailed,
            ))),
            _ => Ok(PollState::InProgress),
        }
    }

    async fn fetch(&self, output_id: &Self::FetchHandle) -> Result<String, CliError> {
        let content_url = format!("{}/files/{output_id}/content", self.api_root);
        self.http
            .get(&content_url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| {
                CliError::new(
                    format!("OpenAI batch results fetch failed: {e}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })?
            .text()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("OpenAI batch results read failed: {e}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })
    }

    fn parse_line(&self, v: &Value) -> Result<LlmSummary, CliError> {
        if let Some(err) = v.get("error") {
            if !err.is_null() {
                let msg = serde_json::to_string(err).unwrap_or_else(|_| "error".into());
                return Err(CliError::new(
                    format!("OpenAI batch item errored: {msg}"),
                    ErrorCode::LlmCallFailed,
                ));
            }
        }
        extract_openai_response("OpenAI", v)
    }
}

fn extract_openai_response(label: &str, line: &Value) -> Result<LlmSummary, CliError> {
    let body = line
        .get("response")
        .and_then(|r| r.get("body"))
        .ok_or_else(|| {
            CliError::new(
                format!("{label} batch result missing response.body"),
                ErrorCode::LlmMalformedOutput,
            )
        })?;
    let content = body
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| {
            CliError::new(
                format!("{label} batch result missing choices[0].message.content"),
                ErrorCode::LlmMalformedOutput,
            )
        })?;
    parse_chat_content(label, content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;

    fn input() -> LlmSummarizeInput {
        LlmSummarizeInput {
            markdown: "doc".into(),
            filename: "f".into(),
            path: "p".into(),
            mime_type: "text/plain".into(),
        }
    }

    fn test_opts(api_key: &str, api_root: String) -> OpenaiProviderOptions {
        OpenaiProviderOptions {
            api_key: api_key.into(),
            model: None,
            api_root: Some(api_root),
        }
    }

    #[tokio::test]
    async fn happy_path_parses_choice_content() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"choices":[{"message":{"content":"{\"summary\":\"S\",\"classification\":\"other\",\"key_topics\":[\"t\"]}"}}]}"#,
            )
            .create_async()
            .await;
        let p = OpenaiProvider::new(test_opts("k", srv.url()));
        let out = p.summarize(&input()).await.unwrap();
        assert_eq!(out.summary, "S");
    }

    #[tokio::test]
    async fn http_error_maps_to_llm_call_failed() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/chat/completions")
            .with_status(429)
            .with_body("rate limited")
            .create_async()
            .await;
        let p = OpenaiProvider::new(test_opts("k", srv.url()));
        let err = p.summarize(&input()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmCallFailed);
        assert!(err.message.contains("429"));
    }

    #[tokio::test]
    async fn empty_choices_errors() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"choices":[]}"#)
            .create_async()
            .await;
        let p = OpenaiProvider::new(test_opts("k", srv.url()));
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
    async fn batch_happy_path_uploads_polls_and_parses() {
        let mut srv = Server::new_async().await;
        let _files = srv
            .mock("POST", "/files")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id":"file-abc","object":"file","purpose":"batch"}"#)
            .create_async()
            .await;
        let _create = srv
            .mock("POST", "/batches")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id":"batch_xyz","status":"validating"}"#)
            .create_async()
            .await;
        let _poll = srv
            .mock("GET", "/batches/batch_xyz")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id":"batch_xyz","status":"completed","output_file_id":"file-out"}"#)
            .create_async()
            .await;
        let _content = srv
            .mock("GET", "/files/file-out/content")
            .with_status(200)
            .with_body(concat!(
                r#"{"custom_id":"i0","response":{"status_code":200,"body":{"choices":[{"message":{"content":"{\"summary\":\"S0\",\"classification\":\"other\",\"key_topics\":[]}"}}]}}}"#,
                "\n",
                r#"{"custom_id":"i1","response":{"status_code":200,"body":{"choices":[{"message":{"content":"{\"summary\":\"S1\",\"classification\":\"financial\",\"key_topics\":[\"x\"]}"}}]}}}"#,
                "\n",
            ))
            .create_async()
            .await;

        let p = OpenaiProvider::new(test_opts("k", srv.url()));
        let inputs = vec![input(), input()];
        let results = p
            .summarize_batch(&inputs, &fast_batch_opts())
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].as_ref().unwrap().summary, "S0");
        assert_eq!(results[1].as_ref().unwrap().summary, "S1");
    }

    #[tokio::test]
    async fn batch_failed_status_errors() {
        let mut srv = Server::new_async().await;
        let _files = srv
            .mock("POST", "/files")
            .with_status(200)
            .with_body(r#"{"id":"file-abc"}"#)
            .create_async()
            .await;
        let _create = srv
            .mock("POST", "/batches")
            .with_status(200)
            .with_body(r#"{"id":"batch_failed","status":"validating"}"#)
            .create_async()
            .await;
        let _poll = srv
            .mock("GET", "/batches/batch_failed")
            .with_status(200)
            .with_body(r#"{"id":"batch_failed","status":"failed"}"#)
            .create_async()
            .await;

        let p = OpenaiProvider::new(test_opts("k", srv.url()));
        let err = p
            .summarize_batch(&[input()], &fast_batch_opts())
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmBatchSubmitFailed);
        assert!(err.message.contains("failed"));
    }

    #[tokio::test]
    async fn supports_batch_is_true() {
        let p = OpenaiProvider::new(OpenaiProviderOptions {
            api_key: "k".into(),
            model: None,
            api_root: None,
        });
        assert!(p.supports_batch());
    }
}
