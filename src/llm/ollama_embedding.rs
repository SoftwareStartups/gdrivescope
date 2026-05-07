//! Ollama embeddings. Ported from `src/llm/ollama-embedding.ts`.
//! Calls /api/embed with explicit dimensions configured by the caller.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::embed_batch::{batch_embed, validate_probe_dimensions, ProbeOptions};
use super::embedding::EmbeddingProvider;
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

    async fn call(&self, input: &serde_json::Value) -> Result<Vec<Vec<f32>>, CliError> {
        let body = json!({ "model": &self.model, "input": input });
        let resp = self
            .http
            .post(format!("{}/api/embed", self.host))
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
                    CliError::new(
                        format!("Ollama embedding call failed: {e}"),
                        ErrorCode::EmbedCallFailed,
                    )
                }
            })?;
        if !resp.status().is_success() {
            return Err(CliError::new(
                format!("Ollama /api/embed returned {}", resp.status()),
                ErrorCode::EmbedCallFailed,
            ));
        }
        let parsed: OllamaEmbedResponse = resp.json().await.map_err(|e| {
            CliError::new(
                format!("Ollama embedding parse failed: {e}"),
                ErrorCode::EmbedCallFailed,
            )
        })?;
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
