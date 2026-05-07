//! Azure OpenAI embeddings.
//! URL: `{endpoint}/openai/deployments/{deployment}/embeddings?api-version=…`.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use super::embed_batch::{batch_embed, validate_probe_dimensions, ProbeOptions};
use super::embedding::EmbeddingProvider;
use super::http::{post_json, Auth, ErrorMapping};
use crate::error::{CliError, ErrorCode};

const BATCH: usize = 96;
const DEFAULT_MODEL: &str = "text-embedding-3-small";
const DEFAULT_DIMENSIONS: usize = 1536;
const DEFAULT_API_VERSION: &str = "2024-06-01";

#[derive(Debug, Deserialize)]
struct EmbeddingsResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingItem {
    embedding: Vec<f32>,
}

pub struct AzureOpenaiEmbeddingProvider {
    http: reqwest::Client,
    api_key: String,
    endpoint: String,
    api_version: String,
    deployment: String,
    model: String,
    dimensions: usize,
    explicit_dimensions: Option<usize>,
}

pub struct AzureOpenaiEmbeddingOptions {
    pub api_key: String,
    pub endpoint: String,
    pub api_version: Option<String>,
    pub deployment: Option<String>,
    pub model: Option<String>,
    pub dimensions: Option<usize>,
}

impl AzureOpenaiEmbeddingProvider {
    pub fn new(opts: AzureOpenaiEmbeddingOptions) -> Self {
        let model = opts.model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
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
            dimensions: opts.dimensions.unwrap_or(DEFAULT_DIMENSIONS),
            explicit_dimensions: opts.dimensions,
        }
    }

    fn url(&self) -> String {
        format!(
            "{}/openai/deployments/{}/embeddings?api-version={}",
            self.endpoint, self.deployment, self.api_version,
        )
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
            &self.url(),
            Auth::Header("api-key", &self.api_key),
            &[],
            body,
            "Azure OpenAI embedding",
            &map,
        )
        .await
    }
}

#[async_trait]
impl EmbeddingProvider for AzureOpenaiEmbeddingProvider {
    fn name(&self) -> &str {
        "azure-openai"
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
            provider_label: "Azure OpenAI",
            model: &self.model,
            remediation_hint:
                "Set GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS or pick a different deployment.",
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
            .mock(
                "POST",
                "/openai/deployments/dep/embeddings?api-version=2024-06-01",
            )
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"embedding":[0.1,0.2]}]}"#)
            .create_async()
            .await;
        let p = AzureOpenaiEmbeddingProvider::new(AzureOpenaiEmbeddingOptions {
            api_key: "k".into(),
            endpoint: srv.url(),
            api_version: None,
            deployment: Some("dep".into()),
            model: None,
            dimensions: Some(2),
        });
        let out = p.embed(&["a".into()]).await.unwrap();
        assert_eq!(out, vec![vec![0.1, 0.2]]);
    }

    #[tokio::test]
    async fn http_error_maps_to_embed_call_failed() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", mockito::Matcher::Any)
            .with_status(503)
            .with_body("down")
            .create_async()
            .await;
        let p = AzureOpenaiEmbeddingProvider::new(AzureOpenaiEmbeddingOptions {
            api_key: "k".into(),
            endpoint: srv.url(),
            api_version: None,
            deployment: Some("dep".into()),
            model: None,
            dimensions: None,
        });
        let err = p.embed(&["a".into()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::EmbedCallFailed);
    }
}
