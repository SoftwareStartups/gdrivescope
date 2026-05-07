//! OpenAI Chat Completions with strict json_schema response_format.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::http::{post_json, Auth, ErrorMapping};
use super::prompts::{summary_user, SUMMARY_SYSTEM};
use super::provider::{LlmProvider, LlmSummarizeInput, LlmSummary};
use super::schema::llm_summary_schema;
use super::summary_parse::validate_raw_summary;
use crate::error::{CliError, ErrorCode};

const OPENAI_API: &str = "https://api.openai.com/v1/chat/completions";
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

pub struct OpenaiProvider {
    http: reqwest::Client,
    api_key: String,
    model: String,
    base_url: String,
}

impl OpenaiProvider {
    pub fn new(api_key: impl Into<String>, model: Option<String>) -> Self {
        Self::with_base_url(api_key, model, OPENAI_API.to_string())
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
impl LlmProvider for OpenaiProvider {
    fn name(&self) -> &str {
        "openai"
    }

    async fn summarize(&self, input: &LlmSummarizeInput) -> Result<LlmSummary, CliError> {
        let body = json!({
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
        });
        let chat: ChatResponse = post_json(
            &self.http,
            &self.base_url,
            Auth::Bearer(&self.api_key),
            &[],
            &body,
            "OpenAI",
            &err_map(),
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
        let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            CliError::new(
                format!("OpenAI returned invalid JSON: {e}"),
                ErrorCode::LlmMalformedOutput,
            )
        })?;
        validate_raw_summary("OpenAI", &parsed)
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
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"choices":[{"message":{"content":"{\"summary\":\"S\",\"classification\":\"other\",\"key_topics\":[\"t\"]}"}}]}"#,
            )
            .create_async()
            .await;
        let p = OpenaiProvider::with_base_url("k", None, srv.url());
        let out = p.summarize(&input()).await.unwrap();
        assert_eq!(out.summary, "S");
    }

    #[tokio::test]
    async fn http_error_maps_to_llm_call_failed() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/")
            .with_status(429)
            .with_body("rate limited")
            .create_async()
            .await;
        let p = OpenaiProvider::with_base_url("k", None, srv.url());
        let err = p.summarize(&input()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmCallFailed);
        assert!(err.message.contains("429"));
    }

    #[tokio::test]
    async fn empty_choices_errors() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"choices":[]}"#)
            .create_async()
            .await;
        let p = OpenaiProvider::with_base_url("k", None, srv.url());
        let err = p.summarize(&input()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmMalformedOutput);
    }
}
