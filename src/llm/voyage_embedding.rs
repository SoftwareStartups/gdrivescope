//! Voyage AI embeddings. Ported from `src/llm/voyage-embedding.ts`.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::embed_batch::{batch_embed, validate_probe_dimensions, ProbeOptions};
use super::embedding::EmbeddingProvider;
use crate::error::{CliError, ErrorCode};

const VOYAGE_API: &str = "https://api.voyageai.com/v1/embeddings";
const BATCH: usize = 128;
const DEFAULT_MODEL: &str = "voyage-3-lite";
const DEFAULT_DIMENSIONS: usize = 512;

#[derive(Debug, Deserialize)]
struct VoyageResponse {
    data: Vec<VoyageItem>,
}

#[derive(Debug, Deserialize)]
struct VoyageItem {
    embedding: Vec<f32>,
}

pub struct VoyageEmbeddingProvider {
    http: reqwest::Client,
    api_key: String,
    model: String,
    dimensions: usize,
    explicit_dimensions: Option<usize>,
}

pub struct VoyageEmbeddingOptions {
    pub api_key: String,
    pub model: Option<String>,
    pub dimensions: Option<usize>,
}

impl VoyageEmbeddingProvider {
    pub fn new(opts: VoyageEmbeddingOptions) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: opts.api_key,
            model: opts.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            dimensions: opts.dimensions.unwrap_or(DEFAULT_DIMENSIONS),
            explicit_dimensions: opts.dimensions,
        }
    }

    fn build_body(&self, input: Vec<String>) -> serde_json::Value {
        let mut body = json!({ "model": &self.model, "input": input });
        if let Some(d) = self.explicit_dimensions {
            body["output_dimension"] = json!(d);
        }
        body
    }

    async fn call(&self, body: &serde_json::Value) -> Result<VoyageResponse, CliError> {
        let resp = self
            .http
            .post(VOYAGE_API)
            .bearer_auth(&self.api_key)
            .json(body)
            .send()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("Voyage embedding call failed: {e}"),
                    ErrorCode::EmbedCallFailed,
                )
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if std::env::var("DEBUG").is_ok() {
                eprintln!("[debug] Voyage API response: {text}");
            }
            return Err(CliError::new(
                format!("Voyage embedding failed (HTTP {status}). Run with DEBUG=1 for details."),
                ErrorCode::EmbedCallFailed,
            ));
        }
        resp.json().await.map_err(|e| {
            CliError::new(
                format!("Voyage embedding parse failed: {e}"),
                ErrorCode::EmbedCallFailed,
            )
        })
    }
}

#[async_trait]
impl EmbeddingProvider for VoyageEmbeddingProvider {
    fn name(&self) -> &str {
        "voyage"
    }
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CliError> {
        batch_embed(texts, BATCH, |batch| async move {
            let body = self.build_body(batch);
            let resp = self.call(&body).await?;
            Ok(resp.data.into_iter().map(|d| d.embedding).collect())
        })
        .await
    }

    async fn probe(&self) -> Result<(), CliError> {
        let body = self.build_body(vec!["probe".to_string()]);
        let resp = self.call(&body).await?;
        validate_probe_dimensions(ProbeOptions {
            actual: resp.data.first().map(|d| d.embedding.len()),
            declared: self.dimensions,
            provider_label: "Voyage",
            model: &self.model,
            remediation_hint:
                "Set GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS or pick a different model.",
        })
    }
}
