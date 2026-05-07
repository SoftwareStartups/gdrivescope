//! `EmbeddingProvider` trait. Ported from `src/llm/embedding-provider.ts`.

use async_trait::async_trait;

use crate::error::CliError;

#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    fn name(&self) -> &str;
    fn dimensions(&self) -> usize;
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CliError>;
    /// Optional: validate that the configured model produces vectors matching
    /// `dimensions()`. Default implementation is a no-op for providers
    /// (Ollama) that already track dimensions explicitly.
    async fn probe(&self) -> Result<(), CliError> {
        Ok(())
    }
}
