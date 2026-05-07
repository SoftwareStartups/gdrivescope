//! Ollama chat. Uses Ollama's `format` parameter for JSON-schema-
//! constrained output. Two-attempt retry on malformed JSON; second attempt
//! adds a stricter system note. Surfaces unreachable host as
//! `PROVIDER_UNAVAILABLE`.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::http::{post_json, Auth, ErrorMapping};
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

    fn err_map(&self) -> ErrorMapping {
        ErrorMapping {
            call: ErrorCode::LlmCallFailed,
            parse: ErrorCode::LlmMalformedOutput,
            unreachable: Some((
                ErrorCode::ProviderUnavailable,
                format!(
                    "Ollama is not reachable at {}. Run `ollama serve` or `gdrivescope ollama setup`.",
                    self.host,
                ),
            )),
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
        post_json(
            &self.http,
            &url,
            Auth::None,
            &[],
            &body,
            "Ollama",
            &self.err_map(),
        )
        .await
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
    async fn happy_path_parses_message_content() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/api/chat")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"message":{"content":"{\"summary\":\"S\",\"classification\":\"other\",\"key_topics\":[\"t\"]}"}}"#,
            )
            .create_async()
            .await;
        let p = OllamaProvider::new(srv.url(), "llama3");
        let out = p.summarize(&input()).await.unwrap();
        assert_eq!(out.summary, "S");
    }

    #[tokio::test]
    async fn http_500_maps_to_llm_call_failed() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/api/chat")
            .with_status(500)
            .with_body("boom")
            .expect_at_least(1)
            .create_async()
            .await;
        let p = OllamaProvider::new(srv.url(), "llama3");
        let err = p.summarize(&input()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmCallFailed);
    }

    #[tokio::test]
    async fn unreachable_host_maps_to_provider_unavailable() {
        let p = OllamaProvider::new("http://127.0.0.1:1", "llama3");
        let err = p.summarize(&input()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::ProviderUnavailable);
        assert!(err.message.contains("not reachable"));
    }
}
