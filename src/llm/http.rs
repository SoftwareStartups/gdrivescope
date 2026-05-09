//! Shared HTTP helper for LLM and embedding providers — authenticated
//! POST + JSON parse with consistent error mapping.

use reqwest::{Client, RequestBuilder};
use serde::{de::DeserializeOwned, Serialize};

use crate::error::{CliError, ErrorCode};

/// How a provider authenticates its requests.
#[derive(Debug, Clone)]
pub enum Auth<'a> {
    /// `Authorization: Bearer <token>` (OpenAI, Voyage).
    Bearer(&'a str),
    /// Custom header (`x-api-key` for Anthropic, `api-key` for Azure).
    Header(&'static str, &'a str),
    /// No authentication (Ollama, when running locally).
    None,
}

/// Error codes used by `post_json`.
///
/// Chat providers use `LlmCallFailed` / `LlmMalformedOutput`. Embedding
/// providers use `EmbedCallFailed` for both. When `unreachable` is set,
/// connect/timeout errors map to it instead of `call` — used by Ollama
/// to surface `ProviderUnavailable`.
#[derive(Debug, Clone)]
pub struct ErrorMapping {
    pub call: ErrorCode,
    pub parse: ErrorCode,
    pub unreachable: Option<(ErrorCode, String)>,
}

/// Standard error mapping for synchronous chat/completion calls.
pub const LLM_CALL_ERROR_MAP: ErrorMapping = ErrorMapping {
    call: ErrorCode::LlmCallFailed,
    parse: ErrorCode::LlmMalformedOutput,
    unreachable: None,
};

/// Standard error mapping for batch submission HTTP calls (file upload,
/// batch creation, status polling). Parse failures collapse into the same
/// code as call failures because they all signal a broken submit pipeline.
pub const LLM_BATCH_SUBMIT_ERROR_MAP: ErrorMapping = ErrorMapping {
    call: ErrorCode::LlmBatchSubmitFailed,
    parse: ErrorCode::LlmBatchSubmitFailed,
    unreachable: None,
};

/// Standard error mapping for embedding calls. Embedding providers
/// collapse parse failures into the same code as call failures.
pub const EMBED_CALL_ERROR_MAP: ErrorMapping = ErrorMapping {
    call: ErrorCode::EmbedCallFailed,
    parse: ErrorCode::EmbedCallFailed,
    unreachable: None,
};

/// POST `body` as JSON to `url` with the given auth, parse the JSON
/// response into `R`, and map transport / status / parse failures to
/// typed `CliError`s.
pub async fn post_json<B: Serialize, R: DeserializeOwned>(
    http: &Client,
    url: &str,
    auth: Auth<'_>,
    extra_headers: &[(&str, &str)],
    body: &B,
    label: &str,
    map: &ErrorMapping,
) -> Result<R, CliError> {
    let mut req: RequestBuilder = http.post(url).json(body);
    req = match auth {
        Auth::Bearer(t) => req.bearer_auth(t),
        Auth::Header(k, v) => req.header(k, v),
        Auth::None => req,
    };
    for (k, v) in extra_headers {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.map_err(|e| {
        if let Some((code, hint)) = &map.unreachable {
            if e.is_connect() || e.is_timeout() {
                return CliError::new(hint.clone(), *code);
            }
        }
        CliError::new(format!("{label} call failed: {e}"), map.call)
    })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(CliError::new(
            format!("{label} call failed (status {status}): {text}"),
            map.call,
        ));
    }
    resp.json()
        .await
        .map_err(|e| CliError::new(format!("{label} parse failed: {e}"), map.parse))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Reply {
        ok: bool,
        msg: String,
    }

    fn err_map() -> ErrorMapping {
        ErrorMapping {
            call: ErrorCode::LlmCallFailed,
            parse: ErrorCode::LlmMalformedOutput,
            unreachable: None,
        }
    }

    #[tokio::test]
    async fn happy_path_round_trip() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/x")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"ok":true,"msg":"hi"}"#)
            .create_async()
            .await;
        let http = Client::new();
        let url = format!("{}/x", srv.url());
        let r: Reply = post_json(
            &http,
            &url,
            Auth::Bearer("k"),
            &[],
            &json!({}),
            "Test",
            &err_map(),
        )
        .await
        .unwrap();
        assert_eq!(
            r,
            Reply {
                ok: true,
                msg: "hi".into()
            }
        );
    }

    #[tokio::test]
    async fn http_error_captures_status_and_body() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/x")
            .with_status(401)
            .with_body("nope")
            .create_async()
            .await;
        let http = Client::new();
        let url = format!("{}/x", srv.url());
        let err = post_json::<_, Reply>(
            &http,
            &url,
            Auth::Bearer("k"),
            &[],
            &json!({}),
            "Test",
            &err_map(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmCallFailed);
        assert!(err.message.contains("401"));
        assert!(err.message.contains("nope"));
    }

    #[tokio::test]
    async fn parse_error_uses_parse_code() {
        let mut srv = Server::new_async().await;
        let _m = srv
            .mock("POST", "/x")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("not json at all")
            .create_async()
            .await;
        let http = Client::new();
        let url = format!("{}/x", srv.url());
        let err =
            post_json::<_, Reply>(&http, &url, Auth::None, &[], &json!({}), "Test", &err_map())
                .await
                .unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmMalformedOutput);
    }

    #[tokio::test]
    async fn unreachable_maps_to_provider_unavailable() {
        let map = ErrorMapping {
            call: ErrorCode::LlmCallFailed,
            parse: ErrorCode::LlmMalformedOutput,
            unreachable: Some((ErrorCode::ProviderUnavailable, "down".into())),
        };
        let http = Client::builder()
            .timeout(std::time::Duration::from_millis(50))
            .build()
            .unwrap();
        // Unroutable address — connect refused / times out fast.
        let err = post_json::<_, Reply>(
            &http,
            "http://127.0.0.1:1",
            Auth::None,
            &[],
            &json!({}),
            "Test",
            &map,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ProviderUnavailable);
        assert_eq!(err.message, "down");
    }
}
