use serde::{Serialize, Serializer};
use thiserror::Error;

/// Stable error code surface emitted in `{ok:false, error, code}` envelopes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    AuthRequired,
    AuthFailed,
    Usage,
    UnknownCommand,
    MissingArg,
    BadArg,
    NodeNotFound,
    ScopeRequired,
    UnsupportedMime,
    ExtractFailed,
    ProviderUnconfigured,
    ProviderUnknown,
    ProviderUnavailable,
    LlmCallFailed,
    LlmMalformedOutput,
    LlmBatchSubmitFailed,
    LlmBatchPollFailed,
    LlmBatchTimeout,
    EmbedCallFailed,
    EmbeddingDimMismatch,
    OllamaPullFailed,
    NoEmbeddings,
    VecExtensionFailed,
    OutputPathInvalid,
    IoFailed,
    DownloadTreeFailed,
    Unknown,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AuthRequired => "AUTH_REQUIRED",
            Self::AuthFailed => "AUTH_FAILED",
            Self::Usage => "USAGE",
            Self::UnknownCommand => "UNKNOWN_COMMAND",
            Self::MissingArg => "MISSING_ARG",
            Self::BadArg => "BAD_ARG",
            Self::NodeNotFound => "NODE_NOT_FOUND",
            Self::ScopeRequired => "SCOPE_REQUIRED",
            Self::UnsupportedMime => "UNSUPPORTED_MIME",
            Self::ExtractFailed => "EXTRACT_FAILED",
            Self::ProviderUnconfigured => "PROVIDER_UNCONFIGURED",
            Self::ProviderUnknown => "PROVIDER_UNKNOWN",
            Self::ProviderUnavailable => "PROVIDER_UNAVAILABLE",
            Self::LlmCallFailed => "LLM_CALL_FAILED",
            Self::LlmMalformedOutput => "LLM_MALFORMED_OUTPUT",
            Self::LlmBatchSubmitFailed => "LLM_BATCH_SUBMIT_FAILED",
            Self::LlmBatchPollFailed => "LLM_BATCH_POLL_FAILED",
            Self::LlmBatchTimeout => "LLM_BATCH_TIMEOUT",
            Self::EmbedCallFailed => "EMBED_CALL_FAILED",
            Self::EmbeddingDimMismatch => "EMBEDDING_DIM_MISMATCH",
            Self::OllamaPullFailed => "OLLAMA_PULL_FAILED",
            Self::NoEmbeddings => "NO_EMBEDDINGS",
            Self::VecExtensionFailed => "VEC_EXTENSION_FAILED",
            Self::OutputPathInvalid => "OUTPUT_PATH_INVALID",
            Self::IoFailed => "IO_FAILED",
            Self::DownloadTreeFailed => "DOWNLOAD_TREE_FAILED",
            Self::Unknown => "UNKNOWN",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for ErrorCode {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(self.as_str())
    }
}

/// Top-level CLI error.
#[derive(Debug, Error)]
#[error("{message}")]
pub struct CliError {
    pub message: String,
    pub code: ErrorCode,
}

impl CliError {
    pub fn new(message: impl Into<String>, code: ErrorCode) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }
}

/// Wrap an arbitrary error into a `CliError` with `Unknown` code.
pub fn wrap_unknown(err: impl std::fmt::Display) -> CliError {
    CliError::new(err.to_string(), ErrorCode::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_string_round_trip() {
        let cases: &[(ErrorCode, &str)] = &[
            (ErrorCode::AuthRequired, "AUTH_REQUIRED"),
            (ErrorCode::AuthFailed, "AUTH_FAILED"),
            (ErrorCode::Usage, "USAGE"),
            (ErrorCode::UnknownCommand, "UNKNOWN_COMMAND"),
            (ErrorCode::MissingArg, "MISSING_ARG"),
            (ErrorCode::BadArg, "BAD_ARG"),
            (ErrorCode::NodeNotFound, "NODE_NOT_FOUND"),
            (ErrorCode::ScopeRequired, "SCOPE_REQUIRED"),
            (ErrorCode::UnsupportedMime, "UNSUPPORTED_MIME"),
            (ErrorCode::ExtractFailed, "EXTRACT_FAILED"),
            (ErrorCode::ProviderUnconfigured, "PROVIDER_UNCONFIGURED"),
            (ErrorCode::ProviderUnknown, "PROVIDER_UNKNOWN"),
            (ErrorCode::ProviderUnavailable, "PROVIDER_UNAVAILABLE"),
            (ErrorCode::LlmCallFailed, "LLM_CALL_FAILED"),
            (ErrorCode::LlmMalformedOutput, "LLM_MALFORMED_OUTPUT"),
            (ErrorCode::LlmBatchSubmitFailed, "LLM_BATCH_SUBMIT_FAILED"),
            (ErrorCode::LlmBatchPollFailed, "LLM_BATCH_POLL_FAILED"),
            (ErrorCode::LlmBatchTimeout, "LLM_BATCH_TIMEOUT"),
            (ErrorCode::EmbedCallFailed, "EMBED_CALL_FAILED"),
            (ErrorCode::EmbeddingDimMismatch, "EMBEDDING_DIM_MISMATCH"),
            (ErrorCode::OllamaPullFailed, "OLLAMA_PULL_FAILED"),
            (ErrorCode::NoEmbeddings, "NO_EMBEDDINGS"),
            (ErrorCode::VecExtensionFailed, "VEC_EXTENSION_FAILED"),
            (ErrorCode::OutputPathInvalid, "OUTPUT_PATH_INVALID"),
            (ErrorCode::IoFailed, "IO_FAILED"),
            (ErrorCode::DownloadTreeFailed, "DOWNLOAD_TREE_FAILED"),
            (ErrorCode::Unknown, "UNKNOWN"),
        ];
        for (code, expected) in cases {
            assert_eq!(code.as_str(), *expected, "as_str for {code:?}");
            assert_eq!(
                serde_json::to_string(code).unwrap(),
                format!("\"{expected}\""),
                "serialize for {code:?}"
            );
        }
    }
}
