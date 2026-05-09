//! Voyage AI embeddings — supports `output_dimension` for matryoshka models.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::embed_batch::{batch_embed, validate_probe_dimensions, ProbeOptions};
use super::embedding::EmbeddingProvider;
use super::http::{post_json, Auth, EMBED_CALL_ERROR_MAP};
use crate::error::CliError;
#[cfg(test)]
use crate::error::ErrorCode;

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
    base_url: String,
}

pub struct VoyageEmbeddingOptions {
    pub api_key: String,
    pub model: Option<String>,
    pub dimensions: Option<usize>,
}

impl VoyageEmbeddingProvider {
    pub fn new(opts: VoyageEmbeddingOptions) -> Self {
        Self::with_base_url(opts, VOYAGE_API.to_string())
    }

    pub fn with_base_url(opts: VoyageEmbeddingOptions, base_url: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: opts.api_key,
            model: opts.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            dimensions: opts.dimensions.unwrap_or(DEFAULT_DIMENSIONS),
            explicit_dimensions: opts.dimensions,
            base_url,
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
        post_json(
            &self.http,
            &self.base_url,
            Auth::Bearer(&self.api_key),
            &[],
            body,
            "Voyage embedding",
            &EMBED_CALL_ERROR_MAP,
        )
        .await
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

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;

    #[tokio::test]
    async fn happy_path_returns_vectors() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"embedding":[0.5,0.5]}]}"#)
            .create_async()
            .await;
        let p = VoyageEmbeddingProvider::with_base_url(
            VoyageEmbeddingOptions {
                api_key: "k".into(),
                model: None,
                dimensions: Some(2),
            },
            srv.url(),
        );
        let out = p.embed(&["a".into()]).await.unwrap();
        assert_eq!(out, vec![vec![0.5, 0.5]]);
    }

    #[tokio::test]
    async fn http_error_maps_to_embed_call_failed() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/")
            .with_status(429)
            .with_body("rate limited")
            .create_async()
            .await;
        let p = VoyageEmbeddingProvider::with_base_url(
            VoyageEmbeddingOptions {
                api_key: "k".into(),
                model: None,
                dimensions: None,
            },
            srv.url(),
        );
        let err = p.embed(&["a".into()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::EmbedCallFailed);
    }
}
