//! Resolve the active LLM and embedding providers.
//!
//! Cascade per provider class:
//!     flag (--provider) → env (GDRIVESCOPE_*_PROVIDER) → config → infer.
//! Inference looks at which API keys are exported and falls back to Ollama
//! when an [ollama] config is present.

use std::sync::Arc;

use super::anthropic::{AnthropicProvider, AnthropicProviderOptions};
use super::azure_openai::{AzureOpenaiProvider, AzureOpenaiProviderOptions};
use super::azure_openai_embedding::{AzureOpenaiEmbeddingOptions, AzureOpenaiEmbeddingProvider};
use super::embedding::EmbeddingProvider;
use super::env::{
    read_embedding_dims_env, read_embedding_model_env, read_llm_model_env, require_env,
    EmbeddingProviderName, LlmProviderName,
};
use super::ollama::{OllamaProvider, OllamaProviderOptions};
use super::ollama_embedding::{OllamaEmbeddingOptions, OllamaEmbeddingProvider};
use super::openai::{OpenaiProvider, OpenaiProviderOptions};
use super::openai_embedding::{OpenaiEmbeddingOptions, OpenaiEmbeddingProvider};
use super::provider::LlmProvider;
use super::voyage_embedding::{VoyageEmbeddingOptions, VoyageEmbeddingProvider};
use crate::config::{AzureConfig, EmbeddingConfig, OllamaConfig};
use crate::error::{CliError, ErrorCode};

const LLM_KEY_HINT: &str = "Export it or pass --provider with a different provider.";
const EMB_KEY_HINT: &str = "Export it or pass --embedding-provider with a different provider.";

#[derive(Debug, Clone, Default)]
pub struct ResolveLlmOptions {
    pub flag_provider: Option<String>,
    pub config_provider: Option<String>,
    pub config_model: Option<String>,
    pub ollama_config: Option<OllamaConfig>,
    pub azure_config: Option<AzureConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ResolveEmbeddingOptions {
    pub flag_provider: Option<String>,
    pub config_provider: Option<String>,
    pub config_model: Option<String>,
    pub embedding_config: Option<EmbeddingConfig>,
    pub ollama_config: Option<OllamaConfig>,
    pub azure_config: Option<AzureConfig>,
}

pub fn resolve_llm_provider(opts: ResolveLlmOptions) -> Result<Arc<dyn LlmProvider>, CliError> {
    let explicit = opts
        .flag_provider
        .clone()
        .or_else(|| std::env::var("GDRIVESCOPE_LLM_PROVIDER").ok())
        .or_else(|| opts.config_provider.clone());

    let name = match explicit {
        Some(n) => LlmProviderName::from_str_ci(&n).ok_or_else(|| {
            CliError::new(format!("Unknown LLM provider: {n}"), ErrorCode::ProviderUnknown)
        })?,
        None => infer_llm(&opts).ok_or_else(|| CliError::new(
            "No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or configure [llm] provider in config.toml.",
            ErrorCode::ProviderUnconfigured,
        ))?,
    };

    let model = read_llm_model_env(name).or_else(|| opts.config_model.clone());

    Ok(match name {
        LlmProviderName::Anthropic => {
            let key = require_env("ANTHROPIC_API_KEY", LLM_KEY_HINT)?;
            Arc::new(AnthropicProvider::new(AnthropicProviderOptions {
                api_key: key,
                model,
                base_url: None,
            }))
        }
        LlmProviderName::OpenAi => {
            let key = require_env("OPENAI_API_KEY", LLM_KEY_HINT)?;
            Arc::new(OpenaiProvider::new(OpenaiProviderOptions {
                api_key: key,
                model,
                api_root: None,
            }))
        }
        LlmProviderName::AzureOpenAi => {
            let key = require_env("AZURE_OPENAI_API_KEY", LLM_KEY_HINT)?;
            let endpoint = std::env::var("AZURE_OPENAI_ENDPOINT").ok().or_else(|| {
                opts.azure_config.as_ref().and_then(|c| c.endpoint.clone())
            }).ok_or_else(|| CliError::new(
                "AZURE_OPENAI_ENDPOINT is not set. Export it or add endpoint to [azure] in config.toml.",
                ErrorCode::ProviderUnconfigured,
            ))?;
            let deployment = std::env::var("AZURE_OPENAI_LLM_DEPLOYMENT")
                .ok()
                .or_else(|| {
                    opts.azure_config
                        .as_ref()
                        .and_then(|c| c.llm_deployment.clone())
                });
            let api_version = std::env::var("AZURE_OPENAI_API_VERSION").ok().or_else(|| {
                opts.azure_config
                    .as_ref()
                    .and_then(|c| c.api_version.clone())
            });
            Arc::new(AzureOpenaiProvider::new(AzureOpenaiProviderOptions {
                api_key: key,
                endpoint,
                api_version,
                deployment,
                model,
            }))
        }
        LlmProviderName::Ollama => {
            let host = std::env::var("GDRIVESCOPE_OLLAMA_HOST")
                .ok()
                .or_else(|| opts.ollama_config.as_ref().and_then(|c| c.host.clone()))
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            let chosen = model
                .or_else(|| {
                    opts.ollama_config
                        .as_ref()
                        .and_then(|c| c.llm_model.clone())
                })
                .unwrap_or_else(|| "llama3.2:3b".to_string());
            Arc::new(OllamaProvider::new(OllamaProviderOptions {
                host,
                model: chosen,
            }))
        }
    })
}

pub fn resolve_embedding_provider(
    opts: ResolveEmbeddingOptions,
) -> Result<Arc<dyn EmbeddingProvider>, CliError> {
    let explicit = opts
        .flag_provider
        .clone()
        .or_else(|| std::env::var("GDRIVESCOPE_EMBEDDING_PROVIDER").ok())
        .or_else(|| opts.config_provider.clone());

    let name = match explicit {
        Some(n) => EmbeddingProviderName::from_str_ci(&n).ok_or_else(|| {
            CliError::new(
                format!("Unknown embedding provider: {n}"),
                ErrorCode::ProviderUnknown,
            )
        })?,
        None => infer_embedding(&opts).ok_or_else(|| CliError::new(
            "No embedding provider configured. Set OPENAI_API_KEY, AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or VOYAGE_API_KEY, or configure [embedding] provider in config.toml.",
            ErrorCode::ProviderUnconfigured,
        ))?,
    };

    let model = read_embedding_model_env(name).or_else(|| opts.config_model.clone());
    let dimensions = read_embedding_dims_env(name)?
        .or_else(|| opts.embedding_config.as_ref().and_then(|c| c.dimensions));

    Ok(match name {
        EmbeddingProviderName::OpenAi => {
            let key = require_env("OPENAI_API_KEY", EMB_KEY_HINT)?;
            Arc::new(OpenaiEmbeddingProvider::new(OpenaiEmbeddingOptions {
                api_key: key,
                model,
                dimensions,
            }))
        }
        EmbeddingProviderName::AzureOpenAi => {
            let key = require_env("AZURE_OPENAI_API_KEY", EMB_KEY_HINT)?;
            let endpoint = std::env::var("AZURE_OPENAI_ENDPOINT").ok().or_else(|| {
                opts.azure_config.as_ref().and_then(|c| c.endpoint.clone())
            }).ok_or_else(|| CliError::new(
                "AZURE_OPENAI_ENDPOINT is not set. Export it or add endpoint to [azure] in config.toml.",
                ErrorCode::ProviderUnconfigured,
            ))?;
            let deployment = std::env::var("AZURE_OPENAI_EMBEDDING_DEPLOYMENT")
                .ok()
                .or_else(|| {
                    opts.azure_config
                        .as_ref()
                        .and_then(|c| c.embedding_deployment.clone())
                });
            let api_version = std::env::var("AZURE_OPENAI_API_VERSION").ok().or_else(|| {
                opts.azure_config
                    .as_ref()
                    .and_then(|c| c.api_version.clone())
            });
            Arc::new(AzureOpenaiEmbeddingProvider::new(
                AzureOpenaiEmbeddingOptions {
                    api_key: key,
                    endpoint,
                    api_version,
                    deployment,
                    model,
                    dimensions,
                },
            ))
        }
        EmbeddingProviderName::Voyage => {
            let key = require_env("VOYAGE_API_KEY", EMB_KEY_HINT)?;
            Arc::new(VoyageEmbeddingProvider::new(VoyageEmbeddingOptions {
                api_key: key,
                model,
                dimensions,
            }))
        }
        EmbeddingProviderName::Ollama => {
            let host = std::env::var("GDRIVESCOPE_OLLAMA_HOST")
                .ok()
                .or_else(|| opts.ollama_config.as_ref().and_then(|c| c.host.clone()))
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            let chosen_model = model
                .or_else(|| {
                    opts.ollama_config
                        .as_ref()
                        .and_then(|c| c.embedding_model.clone())
                })
                .unwrap_or_else(|| "nomic-embed-text".to_string());
            let chosen_dims = dimensions
                .or_else(|| {
                    opts.ollama_config
                        .as_ref()
                        .and_then(|c| c.embedding_dimensions)
                })
                .unwrap_or(768);
            Arc::new(OllamaEmbeddingProvider::new(OllamaEmbeddingOptions {
                host,
                model: chosen_model,
                dimensions: chosen_dims,
            }))
        }
    })
}

fn infer_llm(opts: &ResolveLlmOptions) -> Option<LlmProviderName> {
    if std::env::var("ANTHROPIC_API_KEY").is_ok() {
        return Some(LlmProviderName::Anthropic);
    }
    if std::env::var("OPENAI_API_KEY").is_ok() {
        return Some(LlmProviderName::OpenAi);
    }
    if std::env::var("AZURE_OPENAI_API_KEY").is_ok()
        && std::env::var("AZURE_OPENAI_ENDPOINT").is_ok()
    {
        return Some(LlmProviderName::AzureOpenAi);
    }
    if opts.ollama_config.is_some() {
        return Some(LlmProviderName::Ollama);
    }
    None
}

fn infer_embedding(opts: &ResolveEmbeddingOptions) -> Option<EmbeddingProviderName> {
    if std::env::var("OPENAI_API_KEY").is_ok() {
        return Some(EmbeddingProviderName::OpenAi);
    }
    if std::env::var("AZURE_OPENAI_API_KEY").is_ok()
        && std::env::var("AZURE_OPENAI_ENDPOINT").is_ok()
    {
        return Some(EmbeddingProviderName::AzureOpenAi);
    }
    if std::env::var("VOYAGE_API_KEY").is_ok() {
        return Some(EmbeddingProviderName::Voyage);
    }
    if opts.ollama_config.is_some() {
        return Some(EmbeddingProviderName::Ollama);
    }
    None
}
