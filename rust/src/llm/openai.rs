//! OpenAI Chat Completions API w/ JSON-schema strict response_format.
//! Ported from `src/llm/openai.ts`.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

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
}

impl OpenaiProvider {
    pub fn new(api_key: impl Into<String>, model: Option<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: api_key.into(),
            model: model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        }
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
        let resp = self
            .http
            .post(OPENAI_API)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                CliError::new(format!("OpenAI call failed: {e}"), ErrorCode::LlmCallFailed)
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(CliError::new(
                format!("OpenAI call failed (status {status}): {text}"),
                ErrorCode::LlmCallFailed,
            ));
        }
        let chat: ChatResponse = resp.json().await.map_err(|e| {
            CliError::new(
                format!("OpenAI parse failed: {e}"),
                ErrorCode::LlmMalformedOutput,
            )
        })?;
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
