//! Ollama embeddings (`/api/embed`). Caller supplies the expected
//! dimensions so the probe step can validate model output size.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::embed_batch::{batch_embed, validate_probe_dimensions, ProbeOptions};
use super::embedding::EmbeddingProvider;
use super::http::{post_json, Auth, ErrorMapping};
use crate::error::{CliError, ErrorCode};

const BATCH: usize = 64;

#[derive(Debug, Deserialize)]
struct OllamaEmbedResponse {
    embeddings: Option<Vec<Vec<f32>>>,
}

pub struct OllamaEmbeddingProvider {
    http: reqwest::Client,
    host: String,
    model: String,
    dimensions: usize,
}

pub struct OllamaEmbeddingOptions {
    pub host: String,
    pub model: String,
    pub dimensions: usize,
}

impl OllamaEmbeddingProvider {
    pub fn new(opts: OllamaEmbeddingOptions) -> Self {
        Self {
            http: reqwest::Client::new(),
            host: opts.host.trim_end_matches('/').to_string(),
            model: opts.model,
            dimensions: opts.dimensions,
        }
    }

    pub async fn probe_dimension(host: &str, model: &str, declared: usize) -> Result<(), CliError> {
        let provider = OllamaEmbeddingProvider {
            http: reqwest::Client::new(),
            host: host.trim_end_matches('/').to_string(),
            model: model.to_string(),
            dimensions: declared,
        };
        provider.probe().await
    }

    fn err_map(&self) -> ErrorMapping {
        ErrorMapping {
            call: ErrorCode::EmbedCallFailed,
            parse: ErrorCode::EmbedCallFailed,
            unreachable: Some((
                ErrorCode::ProviderUnavailable,
                format!(
                    "Ollama is not reachable at {}. Run `ollama serve` or `gdrivescope ollama setup`.",
                    self.host,
                ),
            )),
        }
    }

    async fn call(&self, input: &serde_json::Value) -> Result<Vec<Vec<f32>>, CliError> {
        let body = json!({ "model": &self.model, "input": input });
        let parsed: OllamaEmbedResponse = post_json(
            &self.http,
            &format!("{}/api/embed", self.host),
            Auth::None,
            &[],
            &body,
            "Ollama embedding",
            &self.err_map(),
        )
        .await?;
        Ok(parsed.embeddings.unwrap_or_default())
    }
}

#[async_trait]
impl EmbeddingProvider for OllamaEmbeddingProvider {
    fn name(&self) -> &str {
        "ollama"
    }
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CliError> {
        batch_embed(texts, BATCH, |batch| async move {
            self.call(&json!(batch)).await
        })
        .await
    }

    async fn probe(&self) -> Result<(), CliError> {
        let vectors = self.call(&json!("probe")).await?;
        validate_probe_dimensions(ProbeOptions {
            actual: vectors.first().map(|v| v.len()),
            declared: self.dimensions,
            provider_label: "Ollama",
            model: &self.model,
            remediation_hint: "Run `gdrivescope ollama setup` to reconcile.",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;

    #[tokio::test]
    async fn happy_path_returns_vectors() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/api/embed")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"embeddings":[[0.1,0.2,0.3]]}"#)
            .create_async()
            .await;
        let p = OllamaEmbeddingProvider::new(OllamaEmbeddingOptions {
            host: srv.url(),
            model: "nomic".into(),
            dimensions: 3,
        });
        let out = p.embed(&["a".into()]).await.unwrap();
        assert_eq!(out, vec![vec![0.1, 0.2, 0.3]]);
    }

    #[tokio::test]
    async fn unreachable_host_maps_to_provider_unavailable() {
        let p = OllamaEmbeddingProvider::new(OllamaEmbeddingOptions {
            host: "http://127.0.0.1:1".into(),
            model: "nomic".into(),
            dimensions: 3,
        });
        let err = p.embed(&["a".into()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::ProviderUnavailable);
    }
}
