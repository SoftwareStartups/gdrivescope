//! Environment-variable helpers + provider-name enums. Ported from
//! `src/llm/env.ts`.

use crate::error::{CliError, ErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LlmProviderName {
    Anthropic,
    OpenAi,
    AzureOpenAi,
    Ollama,
}

impl LlmProviderName {
    pub fn from_str_ci(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "anthropic" => Some(Self::Anthropic),
            "openai" => Some(Self::OpenAi),
            "azure-openai" | "azure_openai" | "azure" => Some(Self::AzureOpenAi),
            "ollama" => Some(Self::Ollama),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::AzureOpenAi => "azure-openai",
            Self::Ollama => "ollama",
        }
    }

    pub fn model_env(&self) -> &'static str {
        match self {
            Self::Anthropic => "GDRIVESCOPE_ANTHROPIC_MODEL",
            Self::OpenAi => "GDRIVESCOPE_OPENAI_MODEL",
            Self::AzureOpenAi => "GDRIVESCOPE_AZURE_OPENAI_MODEL",
            Self::Ollama => "GDRIVESCOPE_OLLAMA_MODEL",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EmbeddingProviderName {
    OpenAi,
    AzureOpenAi,
    Voyage,
    Ollama,
}

impl EmbeddingProviderName {
    pub fn from_str_ci(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "openai" => Some(Self::OpenAi),
            "azure-openai" | "azure_openai" | "azure" => Some(Self::AzureOpenAi),
            "voyage" => Some(Self::Voyage),
            "ollama" => Some(Self::Ollama),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::AzureOpenAi => "azure-openai",
            Self::Voyage => "voyage",
            Self::Ollama => "ollama",
        }
    }

    pub fn model_env(&self) -> &'static str {
        match self {
            Self::OpenAi => "GDRIVESCOPE_OPENAI_EMBEDDING_MODEL",
            Self::AzureOpenAi => "GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_MODEL",
            Self::Voyage => "GDRIVESCOPE_VOYAGE_EMBEDDING_MODEL",
            Self::Ollama => "GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL",
        }
    }

    pub fn dims_env(&self) -> &'static str {
        match self {
            Self::OpenAi => "GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS",
            Self::AzureOpenAi => "GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS",
            Self::Voyage => "GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS",
            Self::Ollama => "GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS",
        }
    }
}

pub fn read_llm_model_env(name: LlmProviderName) -> Option<String> {
    std::env::var(name.model_env())
        .ok()
        .filter(|s| !s.is_empty())
}

pub fn read_embedding_model_env(name: EmbeddingProviderName) -> Option<String> {
    std::env::var(name.model_env())
        .ok()
        .filter(|s| !s.is_empty())
}

pub fn parse_dims_env(raw: Option<&str>) -> Result<Option<usize>, CliError> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.is_empty() {
        return Ok(None);
    }
    let n: usize = raw.parse().map_err(|_| {
        CliError::new(
            format!("Invalid embedding dimensions env var value: {raw}"),
            ErrorCode::BadArg,
        )
    })?;
    if n == 0 {
        return Err(CliError::new(
            format!("Invalid embedding dimensions env var value: {raw}"),
            ErrorCode::BadArg,
        ));
    }
    Ok(Some(n))
}

pub fn read_embedding_dims_env(name: EmbeddingProviderName) -> Result<Option<usize>, CliError> {
    let raw = std::env::var(name.dims_env()).ok();
    parse_dims_env(raw.as_deref())
}

pub fn require_env(name: &str, hint: &str) -> Result<String, CliError> {
    std::env::var(name).map_err(|_| {
        CliError::new(
            format!("{name} is not set. {hint}"),
            ErrorCode::ProviderUnconfigured,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_dims_env_handles_inputs() {
        assert_eq!(parse_dims_env(None).unwrap(), None);
        assert_eq!(parse_dims_env(Some("")).unwrap(), None);
        assert_eq!(parse_dims_env(Some("1536")).unwrap(), Some(1536));
        assert!(parse_dims_env(Some("0")).is_err());
        assert!(parse_dims_env(Some("nope")).is_err());
        assert!(parse_dims_env(Some("-1")).is_err());
    }

    #[test]
    fn provider_name_round_trips() {
        for s in ["anthropic", "openai", "azure-openai", "ollama"] {
            assert_eq!(LlmProviderName::from_str_ci(s).unwrap().as_str(), s);
        }
        for s in ["openai", "azure-openai", "voyage", "ollama"] {
            assert_eq!(EmbeddingProviderName::from_str_ci(s).unwrap().as_str(), s);
        }
    }

    #[test]
    fn provider_name_aliases_resolve() {
        assert_eq!(
            LlmProviderName::from_str_ci("Azure_OpenAI"),
            Some(LlmProviderName::AzureOpenAi),
        );
        assert_eq!(
            EmbeddingProviderName::from_str_ci("AZURE"),
            Some(EmbeddingProviderName::AzureOpenAi),
        );
    }
}
