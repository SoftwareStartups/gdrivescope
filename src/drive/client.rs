//! Google Drive REST client. Replaces `src/drive/client.ts` plus the
//! `@googleapis/drive` + `google-auth-library` dependencies. Speaks the
//! 3 endpoints we use (files.list, files.get, files.export) directly via
//! `reqwest`, with the access token sourced from the Vault and refreshed
//! once at construction.

use serde::{Deserialize, Serialize};

use crate::auth::oauth::{refresh_access_token, OAuthCredentials};
use crate::auth::vault::VaultStore;
use crate::error::{CliError, ErrorCode};

const DRIVE_BASE: &str = "https://www.googleapis.com/drive/v3";

const AUTH_REQUIRED_MSG: &str = "Run `gdrivescope login` first.";

/// One Drive file. We keep the raw JSON object so we can persist the full
/// payload as `metadata_json` (mirrors the TS `file as Record<string,
/// unknown>` cast) AND offer typed accessors.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DriveFile {
    pub raw: serde_json::Map<String, serde_json::Value>,
}

impl DriveFile {
    pub fn id(&self) -> Option<&str> {
        self.raw.get("id").and_then(serde_json::Value::as_str)
    }
    pub fn name(&self) -> Option<&str> {
        self.raw.get("name").and_then(serde_json::Value::as_str)
    }
    pub fn mime_type(&self) -> Option<&str> {
        self.raw.get("mimeType").and_then(serde_json::Value::as_str)
    }
    pub fn parents(&self) -> Vec<String> {
        self.raw
            .get("parents")
            .and_then(serde_json::Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }
    /// Drive returns sizes as numeric strings (full int range can exceed i32).
    pub fn size(&self) -> Option<u64> {
        self.raw
            .get("size")
            .and_then(serde_json::Value::as_str)
            .and_then(|s| s.parse().ok())
    }
    pub fn modified_time(&self) -> Option<&str> {
        self.raw
            .get("modifiedTime")
            .and_then(serde_json::Value::as_str)
    }
    pub fn created_time(&self) -> Option<&str> {
        self.raw
            .get("createdTime")
            .and_then(serde_json::Value::as_str)
    }
    pub fn web_view_link(&self) -> Option<&str> {
        self.raw
            .get("webViewLink")
            .and_then(serde_json::Value::as_str)
    }
    pub fn shortcut_target_id(&self) -> Option<&str> {
        self.raw.get("shortcutDetails")?.get("targetId")?.as_str()
    }
    pub fn shortcut_target_mime(&self) -> Option<&str> {
        self.raw
            .get("shortcutDetails")?
            .get("targetMimeType")?
            .as_str()
    }
    /// Returns the underlying object as the on-disk metadata JSON.
    pub fn metadata(&self) -> &serde_json::Map<String, serde_json::Value> {
        &self.raw
    }
}

/// One page of `files.list`.
#[derive(Debug, Clone, Deserialize)]
pub struct FilesListPage {
    #[serde(default)]
    pub files: Vec<DriveFile>,
    #[serde(rename = "nextPageToken")]
    pub next_page_token: Option<String>,
}

/// Drive API client. Cheap to clone — `reqwest::Client` is internally Arc'd.
#[derive(Clone)]
pub struct DriveClient {
    http: reqwest::Client,
    access_token: String,
    /// Optional override of the API base URL (for tests).
    base: String,
}

impl DriveClient {
    /// Build a client by reading credentials from the vault and refreshing
    /// the access token once. Mirrors `createDriveClient()` in
    /// `src/drive/client.ts`.
    pub async fn from_vault(vault: &dyn VaultStore) -> Result<Self, CliError> {
        let v = vault
            .get()
            .await?
            .ok_or_else(|| CliError::new(AUTH_REQUIRED_MSG, ErrorCode::AuthRequired))?;
        let creds = OAuthCredentials {
            client_id: std::env::var("GOOGLE_OAUTH_CLIENT_ID")
                .unwrap_or_else(|_| v.client_id.clone()),
            client_secret: std::env::var("GOOGLE_OAUTH_CLIENT_SECRET")
                .unwrap_or_else(|_| v.client_secret.clone()),
        };
        let refresh = refresh_access_token(&v.refresh_token, &creds).await?;
        Ok(Self {
            http: reqwest::Client::new(),
            access_token: refresh.access_token,
            base: DRIVE_BASE.to_string(),
        })
    }

    /// Test-only: build a client pointing at a custom base (e.g. mockito).
    #[cfg(test)]
    pub fn with_token_and_base(token: &str, base: &str) -> Self {
        Self {
            http: reqwest::Client::new(),
            access_token: token.to_string(),
            base: base.to_string(),
        }
    }

    pub async fn files_get(&self, file_id: &str, fields: &str) -> Result<DriveFile, CliError> {
        let url = format!("{}/files/{}", self.base, file_id);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.access_token)
            .query(&[("fields", fields), ("supportsAllDrives", "true")])
            .send()
            .await
            .map_err(net_err("files.get send"))?;
        deserialize_or_error(resp, "files.get").await
    }

    pub async fn files_list(
        &self,
        query: &str,
        fields: &str,
        page_token: Option<&str>,
        page_size: usize,
    ) -> Result<FilesListPage, CliError> {
        let url = format!("{}/files", self.base);
        let mut req = self.http.get(&url).bearer_auth(&self.access_token).query(&[
            ("q", query),
            ("fields", fields),
            ("pageSize", &page_size.to_string()),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ]);
        if let Some(token) = page_token {
            req = req.query(&[("pageToken", token)]);
        }
        let resp = req.send().await.map_err(net_err("files.list send"))?;
        deserialize_or_error(resp, "files.list").await
    }

    /// `files.export` — for Google-native types (Docs/Sheets/Slides/Drawings).
    /// Returns a streaming body the caller can pipe to disk.
    pub async fn files_export(
        &self,
        file_id: &str,
        mime_type: &str,
    ) -> Result<reqwest::Response, CliError> {
        let url = format!("{}/files/{}/export", self.base, file_id);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.access_token)
            .query(&[("mimeType", mime_type)])
            .send()
            .await
            .map_err(net_err("files.export send"))?;
        ensure_ok(resp, "files.export").await
    }

    /// `files.get` with `alt=media` — for non-Google MIME types.
    pub async fn files_get_media(&self, file_id: &str) -> Result<reqwest::Response, CliError> {
        let url = format!("{}/files/{}", self.base, file_id);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.access_token)
            .query(&[("alt", "media"), ("supportsAllDrives", "true")])
            .send()
            .await
            .map_err(net_err("files.get media send"))?;
        ensure_ok(resp, "files.get media").await
    }
}

async fn deserialize_or_error<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    ctx: &str,
) -> Result<T, CliError> {
    let status = resp.status();
    let body = resp.bytes().await.map_err(net_err("read body"))?;
    if !status.is_success() {
        return Err(http_error(ctx, status, &body));
    }
    serde_json::from_slice(&body)
        .map_err(|e| CliError::new(format!("{ctx} parse: {e}"), ErrorCode::Unknown))
}

async fn ensure_ok(resp: reqwest::Response, ctx: &str) -> Result<reqwest::Response, CliError> {
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.bytes().await.unwrap_or_default();
        return Err(http_error(ctx, status, &body));
    }
    Ok(resp)
}

fn net_err(stage: &'static str) -> impl Fn(reqwest::Error) -> CliError {
    move |e| CliError::new(format!("{stage}: {e}"), ErrorCode::Unknown)
}

/// Build a `CliError` from a non-2xx Drive response, attempting to extract a
/// structured Google error body so `permanent_errors::classify` can match
/// reasons. The full JSON body becomes part of the error message under DEBUG.
pub(crate) fn http_error(ctx: &str, status: reqwest::StatusCode, body: &[u8]) -> CliError {
    let body_str = String::from_utf8_lossy(body);
    if std::env::var("DEBUG").is_ok() {
        eprintln!("[debug] {ctx} response ({status}): {body_str}");
    }
    let summary = body_str
        .lines()
        .next()
        .map(|s| s.chars().take(200).collect::<String>())
        .unwrap_or_default();
    CliError::new(
        format!("{ctx}: HTTP {status}: {summary}"),
        ErrorCode::Unknown,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive_file(json: serde_json::Value) -> DriveFile {
        DriveFile {
            raw: json.as_object().cloned().unwrap_or_default(),
        }
    }

    #[test]
    fn drive_file_accessors() {
        let f = drive_file(serde_json::json!({
            "id": "abc",
            "name": "doc.pdf",
            "mimeType": "application/pdf",
            "parents": ["p1"],
            "size": "1234",
            "modifiedTime": "2024-01-01T00:00:00Z",
            "shortcutDetails": {
                "targetId": "tgt-1",
                "targetMimeType": "application/vnd.google-apps.document"
            }
        }));
        assert_eq!(f.id(), Some("abc"));
        assert_eq!(f.name(), Some("doc.pdf"));
        assert_eq!(f.mime_type(), Some("application/pdf"));
        assert_eq!(f.parents(), vec!["p1".to_string()]);
        assert_eq!(f.size(), Some(1234));
        assert_eq!(f.modified_time(), Some("2024-01-01T00:00:00Z"));
        assert_eq!(f.shortcut_target_id(), Some("tgt-1"));
        assert_eq!(
            f.shortcut_target_mime(),
            Some("application/vnd.google-apps.document"),
        );
    }

    #[test]
    fn drive_file_handles_missing_fields_gracefully() {
        let f = drive_file(serde_json::json!({}));
        assert_eq!(f.id(), None);
        assert_eq!(f.parents(), Vec::<String>::new());
        assert_eq!(f.size(), None);
        assert_eq!(f.shortcut_target_id(), None);
    }

    #[test]
    fn files_list_page_deserializes_minimal_response() {
        let json = r#"{"files":[{"id":"a","name":"x"}]}"#;
        let page: FilesListPage = serde_json::from_str(json).unwrap();
        assert_eq!(page.files.len(), 1);
        assert_eq!(page.files[0].id(), Some("a"));
        assert!(page.next_page_token.is_none());
    }

    #[test]
    fn files_list_page_handles_pagination_token() {
        let json = r#"{"files":[],"nextPageToken":"t1"}"#;
        let page: FilesListPage = serde_json::from_str(json).unwrap();
        assert!(page.files.is_empty());
        assert_eq!(page.next_page_token.as_deref(), Some("t1"));
    }

    #[test]
    fn files_list_page_handles_empty_response() {
        let json = r#"{}"#;
        let page: FilesListPage = serde_json::from_str(json).unwrap();
        assert!(page.files.is_empty());
        assert!(page.next_page_token.is_none());
    }
}
