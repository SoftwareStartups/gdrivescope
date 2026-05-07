//! Azure OpenAI Chat Completions.
//! URL: `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::http::{post_json, Auth, ErrorMapping};
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
}

fn err_map() -> ErrorMapping {
    ErrorMapping {
        call: ErrorCode::LlmCallFailed,
        parse: ErrorCode::LlmMalformedOutput,
        unreachable: None,
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
        let chat: ChatResponse = post_json(
            &self.http,
            &url,
            Auth::Header("api-key", &self.api_key),
            &[],
            &body,
            "Azure OpenAI",
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
            .mock("POST", "/openai/deployments/dep/chat/completions?api-version=2024-06-01")
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
}
