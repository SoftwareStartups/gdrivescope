//! `LlmProvider` trait + summarize input/output types.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::classification::Classification;
use crate::error::CliError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmSummary {
    pub summary: String,
    pub classification: Classification,
    pub key_topics: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct LlmSummarizeInput {
    pub markdown: String,
    pub filename: String,
    pub path: String,
    pub mime_type: String,
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn name(&self) -> &str;
    async fn summarize(&self, input: &LlmSummarizeInput) -> Result<LlmSummary, CliError>;
}
