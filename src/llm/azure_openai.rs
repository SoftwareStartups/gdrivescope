//! Azure OpenAI Chat Completions. Ported from `src/llm/azure-openai.ts`.
//! URL shape:
//!   {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::prompts::{summary_user, SUMMARY_SYSTEM};
use super::provider::{LlmProvider, LlmSummarizeInput, LlmSummary};
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
        // Azure can be deployment-by-name OR deployment-equals-model. The TS
        // SDK lets users pass either; we follow the same fallback.
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
}

#[async_trait]
impl LlmProvider for AzureOpenaiProvider {
    fn name(&self) -> &str {
        "azure-openai"
    }

    async fn summarize(&self, input: &LlmSummarizeInput) -> Result<LlmSummary, CliError> {
        let url = format!(
            "{}/openai/deployments/{}/chat/completions?api-version={}",
            self.endpoint, self.deployment, self.api_version,
        );
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
            .post(&url)
            .header("api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("Azure OpenAI call failed: {e}"),
                    ErrorCode::LlmCallFailed,
                )
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(CliError::new(
                format!("Azure OpenAI call failed (status {status}): {text}"),
                ErrorCode::LlmCallFailed,
            ));
        }
        let chat: ChatResponse = resp.json().await.map_err(|e| {
            CliError::new(
                format!("Azure OpenAI parse failed: {e}"),
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
                    "Azure OpenAI returned empty content",
                    ErrorCode::LlmMalformedOutput,
                )
            })?;
        let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            CliError::new(
                format!("Azure OpenAI returned invalid JSON: {e}"),
                ErrorCode::LlmMalformedOutput,
            )
        })?;
        validate_raw_summary("Azure OpenAI", &parsed)
    }
}
