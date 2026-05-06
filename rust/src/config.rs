//! TOML workspace config. Full TOML parsing arrives in Phase 7; for now
//! we expose only the small structs that earlier phases (4 = ConfigRoot,
//! 6 = provider config slots) need to compile.

use serde::{Deserialize, Serialize};

/// One configured Drive root. Mirrors the `[[roots]]` entries in
/// `~/.config/gdrivescope/config.toml`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigRoot {
    /// Drive folder id, or the literal `"root"` sentinel for My Drive.
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// `[azure]` section: shared Azure OpenAI endpoint + per-purpose deployments.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AzureConfig {
    pub endpoint: Option<String>,
    pub api_version: Option<String>,
    pub llm_deployment: Option<String>,
    pub embedding_deployment: Option<String>,
}

/// `[ollama]` section: local Ollama overrides.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OllamaConfig {
    pub host: Option<String>,
    pub llm_model: Option<String>,
    pub embedding_model: Option<String>,
    pub embedding_dimensions: Option<usize>,
}

/// `[embedding]` section: cross-provider embedding overrides.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmbeddingConfig {
    pub dimensions: Option<usize>,
}

/// `[llm]` section: cross-provider LLM overrides.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmConfig {
    pub provider: Option<String>,
    pub model: Option<String>,
}
