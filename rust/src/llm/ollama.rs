//! Ollama chat API. Ported from `src/llm/ollama.ts`.
//! Uses Ollama's `format` parameter for JSON-schema-constrained output.
//! Two-attempt retry on malformed JSON; second attempt adds a stricter
//! system note. Surfaces unreachable host as PROVIDER_UNAVAILABLE.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::prompts::{summary_user, SUMMARY_SYSTEM};
use super::provider::{LlmProvider, LlmSummarizeInput, LlmSummary};
use super::schema::llm_summary_schema;
use super::summary_parse::validate_raw_summary;
use crate::error::{CliError, ErrorCode};

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: Message,
}

#[derive(Debug, Deserialize)]
struct Message {
    content: String,
}

pub struct OllamaProvider {
    http: reqwest::Client,
    host: String,
    model: String,
}

impl OllamaProvider {
    pub fn new(host: impl Into<String>, model: impl Into<String>) -> Self {
        let host = host.into();
        Self {
            http: reqwest::Client::new(),
            host: host.trim_end_matches('/').to_string(),
            model: model.into(),
        }
    }

    async fn call(&self, messages: &serde_json::Value) -> Result<OllamaChatResponse, CliError> {
        let url = format!("{}/api/chat", self.host);
        let body = json!({
            "model": &self.model,
            "stream": false,
            "format": llm_summary_schema(),
            "messages": messages,
        });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    CliError::new(
                        format!(
                            "Ollama is not reachable at {}. Run `ollama serve` or `gdrivescope ollama setup`.",
                            self.host,
                        ),
                        ErrorCode::ProviderUnavailable,
                    )
                } else {
                    CliError::new(format!("Ollama call failed: {e}"), ErrorCode::LlmCallFailed)
                }
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(CliError::new(
                format!("Ollama {status}: {text}"),
                ErrorCode::LlmCallFailed,
            ));
        }
        resp.json().await.map_err(|e| {
            CliError::new(
                format!("Ollama parse failed: {e}"),
                ErrorCode::LlmMalformedOutput,
            )
        })
    }
}

#[async_trait]
impl LlmProvider for OllamaProvider {
    fn name(&self) -> &str {
        "ollama"
    }

    async fn summarize(&self, input: &LlmSummarizeInput) -> Result<LlmSummary, CliError> {
        let user = summary_user(&input.filename, &input.path, &input.markdown);
        let baseline = json!([
            { "role": "system", "content": SUMMARY_SYSTEM },
            { "role": "user", "content": user },
        ]);

        // First attempt.
        match self.call(&baseline).await {
            Ok(resp) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&resp.message.content) {
                    return validate_raw_summary("Ollama", &v);
                }
            }
            Err(e) if e.code != ErrorCode::LlmMalformedOutput => return Err(e),
            Err(_) => {} // fall through to retry
        }

        // Second attempt with strict instruction.
        let stricter = json!([
            {
                "role": "system",
                "content": format!(
                    "{SUMMARY_SYSTEM}\n\nYour reply MUST be a JSON object matching the provided schema exactly. Do not include prose outside the JSON.",
                ),
            },
            { "role": "user", "content": summary_user(&input.filename, &input.path, &input.markdown) },
        ]);
        let resp = self.call(&stricter).await?;
        match serde_json::from_str::<serde_json::Value>(&resp.message.content) {
            Ok(v) => validate_raw_summary("Ollama", &v),
            Err(_) => Err(CliError::new(
                format!(
                    "Ollama model {} did not return schema-conformant JSON on two attempts.",
                    self.model,
                ),
                ErrorCode::LlmMalformedOutput,
            )),
        }
    }
}
