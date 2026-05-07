//! OpenAI embeddings (`/v1/embeddings`).

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::embed_batch::{batch_embed, validate_probe_dimensions, ProbeOptions};
use super::embedding::EmbeddingProvider;
use super::http::{post_json, Auth, ErrorMapping};
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
    base_url: String,
}

pub struct OpenaiEmbeddingOptions {
    pub api_key: String,
    pub model: Option<String>,
    pub dimensions: Option<usize>,
}

impl OpenaiEmbeddingProvider {
    pub fn new(opts: OpenaiEmbeddingOptions) -> Self {
        Self::with_base_url(opts, OPENAI_EMBEDDINGS_API.to_string())
    }

    pub fn with_base_url(opts: OpenaiEmbeddingOptions, base_url: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: opts.api_key,
            model: opts.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            dimensions: opts.dimensions.unwrap_or(DEFAULT_DIMENSIONS),
            explicit_dimensions: opts.dimensions,
            base_url,
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
        let map = ErrorMapping {
            call: ErrorCode::EmbedCallFailed,
            parse: ErrorCode::EmbedCallFailed,
            unreachable: None,
        };
        post_json(
            &self.http,
            &self.base_url,
            Auth::Bearer(&self.api_key),
            &[],
            body,
            "OpenAI embedding",
            &map,
        )
        .await
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
            .with_body(r#"{"data":[{"embedding":[0.1,0.2,0.3]},{"embedding":[0.4,0.5,0.6]}]}"#)
            .create_async()
            .await;
        let p = OpenaiEmbeddingProvider::with_base_url(
            OpenaiEmbeddingOptions {
                api_key: "k".into(),
                model: None,
                dimensions: Some(3),
            },
            srv.url(),
        );
        let out = p.embed(&["a".into(), "b".into()]).await.unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], vec![0.1, 0.2, 0.3]);
    }

    #[tokio::test]
    async fn http_error_maps_to_embed_call_failed() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/")
            .with_status(401)
            .with_body("nope")
            .create_async()
            .await;
        let p = OpenaiEmbeddingProvider::with_base_url(
            OpenaiEmbeddingOptions {
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
