//! Azure OpenAI Chat Completions.
//! URL: `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`.
//!
//! The Batch API runs at `{endpoint}/openai/files` and
//! `{endpoint}/openai/batches` (note: not deployment-scoped — the batch
//! input JSONL itself names the deployment via the `model` field).

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

const DEFAULT_API_VERSION: &str = "2024-06-01";
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

pub struct AzureOpenaiProvider {
    http: reqwest::Client,
    api_key: String,
    endpoint: String,
    api_version: String,
    deployment: String,
    model: String,
}

pub struct AzureOpenaiProviderOptions {
    pub api_key: String,
    pub endpoint: String,
    pub api_version: Option<String>,
    pub deployment: Option<String>,
    pub model: Option<String>,
}

impl AzureOpenaiProvider {
    pub fn new(opts: AzureOpenaiProviderOptions) -> Self {
        let model = opts.model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
        // Azure deployments can be named arbitrarily or named to match the
        // model — fall back to the model name if no explicit deployment.
        let deployment = opts.deployment.unwrap_or_else(|| model.clone());
        Self {
            http: reqwest::Client::new(),
            api_key: opts.api_key,
            endpoint: opts.endpoint.trim_end_matches('/').to_string(),
            api_version: opts
                .api_version
                .unwrap_or_else(|| DEFAULT_API_VERSION.to_string()),
            deployment,
            model,
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

    fn url(&self, path: &str) -> String {
        format!(
            "{}/openai{}?api-version={}",
            self.endpoint, path, self.api_version,
        )
    }

    fn url_for_chat(&self) -> String {
        self.url(&format!(
            "/deployments/{}/chat/completions",
            self.deployment,
        ))
    }
}

fn parse_chat_content(label: &str, content: &str) -> Result<LlmSummary, CliError> {
    let parsed: Value = serde_json::from_str(content).map_err(|e| {
        CliError::new(
            format!("{label} returned invalid JSON: {e}"),
            ErrorCode::LlmMalformedOutput,
        )
    })?;
    validate_raw_summary(label, &parsed)
}

fn extract_response(label: &str, line: &Value) -> Result<LlmSummary, CliError> {
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

#[async_trait]
impl LlmProvider for AzureOpenaiProvider {
    fn name(&self) -> &str {
        "azure-openai"
    }

    fn supports_batch(&self) -> bool {
        true
    }

    async fn summarize(&self, input: &LlmSummarizeInput) -> Result<LlmSummary, CliError> {
        let chat: ChatResponse = post_json(
            &self.http,
            &self.url_for_chat(),
            Auth::Header("api-key", &self.api_key),
            &[],
            &self.chat_body(input),
            "Azure OpenAI",
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
                    "Azure OpenAI returned empty content",
                    ErrorCode::LlmMalformedOutput,
                )
            })?;
        parse_chat_content("Azure OpenAI", &text)
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
impl BatchOps for AzureOpenaiProvider {
    type SubmitHandle = String;
    type FetchHandle = String;

    fn label(&self) -> &'static str {
        "Azure OpenAI"
    }

    async fn submit(&self, inputs: &[LlmSummarizeInput]) -> Result<Self::SubmitHandle, CliError> {
        // The URL inside each JSONL line points at the deployment-scoped
        // chat completions path.
        let inner_url = format!("/openai/deployments/{}/chat/completions", self.deployment);
        let mut jsonl = String::new();
        for (i, input) in inputs.iter().enumerate() {
            let line = json!({
                "custom_id": make_custom_id(i),
                "method": "POST",
                "url": inner_url,
                "body": self.chat_body(input),
            });
            jsonl.push_str(&serde_json::to_string(&line).map_err(|e| {
                CliError::new(
                    format!("Azure OpenAI batch JSONL build failed: {e}"),
                    ErrorCode::LlmBatchSubmitFailed,
                )
            })?);
            jsonl.push('\n');
        }

        let files_url = self.url("/files");
        let form = reqwest::multipart::Form::new()
            .text("purpose", "batch")
            .part(
                "file",
                reqwest::multipart::Part::bytes(jsonl.into_bytes())
                    .file_name("batch_input.jsonl")
                    .mime_str("application/jsonl")
                    .map_err(|e| {
                        CliError::new(
                            format!("Azure OpenAI batch multipart build failed: {e}"),
                            ErrorCode::LlmBatchSubmitFailed,
                        )
                    })?,
            );
        let upload_resp = self
            .http
            .post(&files_url)
            .header("api-key", &self.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("Azure OpenAI batch upload failed: {e}"),
                    ErrorCode::LlmBatchSubmitFailed,
                )
            })?;
        if !upload_resp.status().is_success() {
            let status = upload_resp.status();
            let text = upload_resp.text().await.unwrap_or_default();
            return Err(CliError::new(
                format!("Azure OpenAI batch upload failed (status {status}): {text}"),
                ErrorCode::LlmBatchSubmitFailed,
            ));
        }
        let uploaded: FileUploadResponse = upload_resp.json().await.map_err(|e| {
            CliError::new(
                format!("Azure OpenAI batch upload parse failed: {e}"),
                ErrorCode::LlmBatchSubmitFailed,
            )
        })?;

        let create_url = self.url("/batches");
        let created: BatchCreateResponse = post_json(
            &self.http,
            &create_url,
            Auth::Header("api-key", &self.api_key),
            &[],
            &json!({
                "input_file_id": uploaded.id,
                "endpoint": "/v1/chat/completions",
                "completion_window": "24h",
            }),
            "Azure OpenAI batch",
            &LLM_BATCH_SUBMIT_ERROR_MAP,
        )
        .await?;
        Ok(created.id)
    }

    async fn poll(
        &self,
        batch_id: &Self::SubmitHandle,
    ) -> Result<PollState<Self::FetchHandle>, CliError> {
        let status_url = self.url(&format!("/batches/{batch_id}"));
        let resp = self
            .http
            .get(&status_url)
            .header("api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("Azure OpenAI batch poll failed: {e}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Ok(PollState::Failed(CliError::new(
                format!("Azure OpenAI batch poll failed (status {status}): {text}"),
                ErrorCode::LlmBatchPollFailed,
            )));
        }
        let body: BatchObject = resp.json().await.map_err(|e| {
            CliError::new(
                format!("Azure OpenAI batch poll parse failed: {e}"),
                ErrorCode::LlmBatchPollFailed,
            )
        })?;
        match body.status.as_str() {
            "completed" => {
                let output_id = body.output_file_id.ok_or_else(|| {
                    CliError::new(
                        "Azure OpenAI batch completed without output_file_id",
                        ErrorCode::LlmBatchPollFailed,
                    )
                })?;
                Ok(PollState::Done(output_id))
            }
            "failed" | "expired" | "cancelled" => Ok(PollState::Failed(CliError::new(
                format!("Azure OpenAI batch ended with status {}", body.status),
                ErrorCode::LlmBatchSubmitFailed,
            ))),
            _ => Ok(PollState::InProgress),
        }
    }

    async fn fetch(&self, output_id: &Self::FetchHandle) -> Result<String, CliError> {
        let content_url = self.url(&format!("/files/{output_id}/content"));
        self.http
            .get(&content_url)
            .header("api-key", &self.api_key)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| {
                CliError::new(
                    format!("Azure OpenAI batch results fetch failed: {e}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })?
            .text()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("Azure OpenAI batch results read failed: {e}"),
                    ErrorCode::LlmBatchPollFailed,
                )
            })
    }

    fn parse_line(&self, v: &Value) -> Result<LlmSummary, CliError> {
        if let Some(err) = v.get("error") {
            if !err.is_null() {
                let msg = serde_json::to_string(err).unwrap_or_else(|_| "error".into());
                return Err(CliError::new(
                    format!("Azure OpenAI batch item errored: {msg}"),
                    ErrorCode::LlmCallFailed,
                ));
            }
        }
        extract_response("Azure OpenAI", v)
    }
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

    #[tokio::test]
    async fn happy_path_parses_choice_content() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock(
                "POST",
                "/openai/deployments/dep/chat/completions?api-version=2024-06-01",
            )
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"choices":[{"message":{"content":"{\"summary\":\"S\",\"classification\":\"other\",\"key_topics\":[\"t\"]}"}}]}"#,
            )
            .create_async()
            .await;
        let p = AzureOpenaiProvider::new(AzureOpenaiProviderOptions {
            api_key: "k".into(),
            endpoint: srv.url(),
            api_version: None,
            deployment: Some("dep".into()),
            model: None,
        });
        let out = p.summarize(&input()).await.unwrap();
        assert_eq!(out.summary, "S");
    }

    #[tokio::test]
    async fn http_error_maps_to_llm_call_failed() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", mockito::Matcher::Any)
            .with_status(403)
            .with_body("forbidden")
            .create_async()
            .await;
        let p = AzureOpenaiProvider::new(AzureOpenaiProviderOptions {
            api_key: "k".into(),
            endpoint: srv.url(),
            api_version: None,
            deployment: Some("dep".into()),
            model: None,
        });
        let err = p.summarize(&input()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmCallFailed);
        assert!(err.message.contains("403"));
    }

    fn fast_batch_opts() -> BatchOptions {
        BatchOptions {
            timeout: std::time::Duration::from_secs(5),
            poll_interval: std::time::Duration::from_millis(1),
        }
    }

    #[tokio::test]
    async fn batch_routes_through_openai_files_and_batches() {
        let mut srv = Server::new_async().await;
        let _files = srv
            .mock(
                "POST",
                mockito::Matcher::Regex(r"^/openai/files\?api-version=2024-06-01$".to_string()),
            )
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id":"file-az"}"#)
            .create_async()
            .await;
        let _create = srv
            .mock(
                "POST",
                mockito::Matcher::Regex(r"^/openai/batches\?api-version=2024-06-01$".to_string()),
            )
            .with_status(200)
            .with_body(r#"{"id":"batch_az","status":"validating"}"#)
            .create_async()
            .await;
        let _poll = srv
            .mock(
                "GET",
                mockito::Matcher::Regex(
                    r"^/openai/batches/batch_az\?api-version=2024-06-01$".to_string(),
                ),
            )
            .with_status(200)
            .with_body(r#"{"id":"batch_az","status":"completed","output_file_id":"file-out"}"#)
            .create_async()
            .await;
        let _content = srv
            .mock(
                "GET",
                mockito::Matcher::Regex(
                    r"^/openai/files/file-out/content\?api-version=2024-06-01$".to_string(),
                ),
            )
            .with_status(200)
            .with_body(concat!(
                r#"{"custom_id":"i0","response":{"status_code":200,"body":{"choices":[{"message":{"content":"{\"summary\":\"S0\",\"classification\":\"other\",\"key_topics\":[]}"}}]}}}"#,
                "\n",
            ))
            .create_async()
            .await;

        let p = AzureOpenaiProvider::new(AzureOpenaiProviderOptions {
            api_key: "k".into(),
            endpoint: srv.url(),
            api_version: None,
            deployment: Some("dep".into()),
            model: None,
        });
        let results = p
            .summarize_batch(&[input()], &fast_batch_opts())
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].as_ref().unwrap().summary, "S0");
    }

    #[tokio::test]
    async fn supports_batch_is_true() {
        let p = AzureOpenaiProvider::new(AzureOpenaiProviderOptions {
            api_key: "k".into(),
            endpoint: "https://x.openai.azure.com".into(),
            api_version: None,
            deployment: None,
            model: None,
        });
        assert!(p.supports_batch());
    }
}
