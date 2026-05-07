//! OpenAI embeddings. Ported from `src/llm/openai-embedding.ts`.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::embed_batch::{batch_embed, validate_probe_dimensions, ProbeOptions};
use super::embedding::EmbeddingProvider;
use crate::error::{CliError, ErrorCode};

const OPENAI_EMBEDDINGS_API: &str = "https://api.openai.com/v1/embeddings";
const BATCH: usize = 96;
const DEFAULT_MODEL: &str = "text-embedding-3-small";
const DEFAULT_DIMENSIONS: usize = 1536;

#[derive(Debug, Deserialize)]
pub(super) struct EmbeddingsResponse {
    pub data: Vec<EmbeddingItem>,
}

#[derive(Debug, Deserialize)]
pub(super) struct EmbeddingItem {
    pub embedding: Vec<f32>,
}

pub struct OpenaiEmbeddingProvider {
    http: reqwest::Client,
    api_key: String,
    model: String,
    dimensions: usize,
    explicit_dimensions: Option<usize>,
}

pub struct OpenaiEmbeddingOptions {
    pub api_key: String,
    pub model: Option<String>,
    pub dimensions: Option<usize>,
}

impl OpenaiEmbeddingProvider {
    pub fn new(opts: OpenaiEmbeddingOptions) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: opts.api_key,
            model: opts.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            dimensions: opts.dimensions.unwrap_or(DEFAULT_DIMENSIONS),
            explicit_dimensions: opts.dimensions,
        }
    }

    fn build_body(&self, input: &serde_json::Value) -> serde_json::Value {
        let mut body = json!({ "model": &self.model, "input": input });
        if let Some(d) = self.explicit_dimensions {
            body["dimensions"] = json!(d);
        }
        body
    }

    async fn call(&self, body: &serde_json::Value) -> Result<EmbeddingsResponse, CliError> {
        let resp = self
            .http
            .post(OPENAI_EMBEDDINGS_API)
            .bearer_auth(&self.api_key)
            .json(body)
            .send()
            .await
            .map_err(|e| {
                CliError::new(
                    format!("OpenAI embedding call failed: {e}"),
                    ErrorCode::EmbedCallFailed,
                )
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(CliError::new(
                format!("OpenAI embedding call failed (status {status}): {text}"),
                ErrorCode::EmbedCallFailed,
            ));
        }
        resp.json().await.map_err(|e| {
            CliError::new(
                format!("OpenAI embedding parse failed: {e}"),
                ErrorCode::EmbedCallFailed,
            )
        })
    }
}

#[async_trait]
impl EmbeddingProvider for OpenaiEmbeddingProvider {
    fn name(&self) -> &str {
        "openai"
    }
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CliError> {
        batch_embed(texts, BATCH, |batch| async move {
            let body = self.build_body(&json!(batch));
            let resp = self.call(&body).await?;
            Ok(resp.data.into_iter().map(|d| d.embedding).collect())
        })
        .await
    }

    async fn probe(&self) -> Result<(), CliError> {
        let body = self.build_body(&json!("probe"));
        let resp = self.call(&body).await?;
        validate_probe_dimensions(ProbeOptions {
            actual: resp.data.first().map(|d| d.embedding.len()),
            declared: self.dimensions,
            provider_label: "OpenAI",
            model: &self.model,
            remediation_hint:
                "Set GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS or pick a different model.",
        })
    }
}
