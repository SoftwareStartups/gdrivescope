use serde::{Serialize, Serializer};
use thiserror::Error;

/// Stable error code surface emitted in `{ok:false, error, code}` envelopes.
/// Mirrors `ErrorCode` in `src/utils/errors.ts` byte-for-byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    AuthRequired,
    AuthFailed,
    Usage,
    UnknownCommand,
    NotImplemented,
    NotYetImplemented,
    MissingArg,
    BadArg,
    NodeNotFound,
    ScopeRequired,
    UnsupportedMime,
    ExtractFailed,
    PdfSliceFailed,
    ProviderUnconfigured,
    ProviderUnknown,
    ProviderUnavailable,
    LlmCallFailed,
    LlmMalformedOutput,
    EmbedCallFailed,
    EmbeddingDimMismatch,
    OllamaPullFailed,
    NoEmbeddings,
    VecExtensionFailed,
    Unknown,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AuthRequired => "AUTH_REQUIRED",
            Self::AuthFailed => "AUTH_FAILED",
            Self::Usage => "USAGE",
            Self::UnknownCommand => "UNKNOWN_COMMAND",
            Self::NotImplemented => "NOT_IMPLEMENTED",
            Self::NotYetImplemented => "NOT_YET_IMPLEMENTED",
            Self::MissingArg => "MISSING_ARG",
            Self::BadArg => "BAD_ARG",
            Self::NodeNotFound => "NODE_NOT_FOUND",
            Self::ScopeRequired => "SCOPE_REQUIRED",
            Self::UnsupportedMime => "UNSUPPORTED_MIME",
            Self::ExtractFailed => "EXTRACT_FAILED",
            Self::PdfSliceFailed => "PDF_SLICE_FAILED",
            Self::ProviderUnconfigured => "PROVIDER_UNCONFIGURED",
            Self::ProviderUnknown => "PROVIDER_UNKNOWN",
            Self::ProviderUnavailable => "PROVIDER_UNAVAILABLE",
            Self::LlmCallFailed => "LLM_CALL_FAILED",
            Self::LlmMalformedOutput => "LLM_MALFORMED_OUTPUT",
            Self::EmbedCallFailed => "EMBED_CALL_FAILED",
            Self::EmbeddingDimMismatch => "EMBEDDING_DIM_MISMATCH",
            Self::OllamaPullFailed => "OLLAMA_PULL_FAILED",
            Self::NoEmbeddings => "NO_EMBEDDINGS",
            Self::VecExtensionFailed => "VEC_EXTENSION_FAILED",
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

/// Top-level CLI error. Replaces `CliError` from `src/utils/errors.ts`.
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
/// Mirrors the `unknown` fallback in TS `toResponse(err)`.
pub fn wrap_unknown(err: impl std::fmt::Display) -> CliError {
    CliError::new(err.to_string(), ErrorCode::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each variant must serialize to the exact TS string. Drift would break
    /// cross-binary `--json` envelopes consumers parse against.
    #[test]
    fn error_code_strings_match_ts_union() {
        let cases: &[(ErrorCode, &str)] = &[
            (ErrorCode::AuthRequired, "AUTH_REQUIRED"),
            (ErrorCode::AuthFailed, "AUTH_FAILED"),
            (ErrorCode::Usage, "USAGE"),
            (ErrorCode::UnknownCommand, "UNKNOWN_COMMAND"),
            (ErrorCode::NotImplemented, "NOT_IMPLEMENTED"),
            (ErrorCode::NotYetImplemented, "NOT_YET_IMPLEMENTED"),
            (ErrorCode::MissingArg, "MISSING_ARG"),
            (ErrorCode::BadArg, "BAD_ARG"),
            (ErrorCode::NodeNotFound, "NODE_NOT_FOUND"),
            (ErrorCode::ScopeRequired, "SCOPE_REQUIRED"),
            (ErrorCode::UnsupportedMime, "UNSUPPORTED_MIME"),
            (ErrorCode::ExtractFailed, "EXTRACT_FAILED"),
            (ErrorCode::PdfSliceFailed, "PDF_SLICE_FAILED"),
            (ErrorCode::ProviderUnconfigured, "PROVIDER_UNCONFIGURED"),
            (ErrorCode::ProviderUnknown, "PROVIDER_UNKNOWN"),
            (ErrorCode::ProviderUnavailable, "PROVIDER_UNAVAILABLE"),
            (ErrorCode::LlmCallFailed, "LLM_CALL_FAILED"),
            (ErrorCode::LlmMalformedOutput, "LLM_MALFORMED_OUTPUT"),
            (ErrorCode::EmbedCallFailed, "EMBED_CALL_FAILED"),
            (ErrorCode::EmbeddingDimMismatch, "EMBEDDING_DIM_MISMATCH"),
            (ErrorCode::OllamaPullFailed, "OLLAMA_PULL_FAILED"),
            (ErrorCode::NoEmbeddings, "NO_EMBEDDINGS"),
            (ErrorCode::VecExtensionFailed, "VEC_EXTENSION_FAILED"),
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
