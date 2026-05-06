//! Classifies Drive API errors into permanent vs transient. Mirrors
//! `src/drive/permanent-errors.ts` 1:1: same reasons, same prefix marker,
//! same message format. The pipeline persists permanent errors into
//! `nodes.last_error` with the prefix so resume runs skip them.

use crate::error::CliError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermanentReason {
    AppNotAuthorizedToFile,
    Forbidden,
    FileNotDownloadable,
}

impl PermanentReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AppNotAuthorizedToFile => "appNotAuthorizedToFile",
            Self::Forbidden => "forbidden",
            Self::FileNotDownloadable => "fileNotDownloadable",
        }
    }

    fn from_reason(reason: &str) -> Option<Self> {
        match reason {
            "appNotAuthorizedToFile" => Some(Self::AppNotAuthorizedToFile),
            "forbidden" => Some(Self::Forbidden),
            "fileNotDownloadable" => Some(Self::FileNotDownloadable),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PermanentInfo {
    pub reason: PermanentReason,
    pub http_status: u16,
}

pub const PERMANENT_ERROR_PREFIX: &str = "[permanent:";

/// Inspect an arbitrary error. Returns `Some` iff the error encodes one of
/// the known permanent Drive reasons either via structured Google error body
/// or via a flattened message-string fallback.
pub fn classify(err: &CliError) -> Option<PermanentInfo> {
    let msg = &err.message;
    // Best-effort: parse JSON-shaped Google errors that may have been
    // captured into the message text. The TS code does `response?.data?.error`
    // → `errors[0].reason`; in our http_error helper we put the first body
    // line into the message, which generally contains JSON if the API
    // returned a structured error.
    if let Some(reason) = extract_reason_from_json_body(msg) {
        if let Some(reason) = PermanentReason::from_reason(&reason) {
            return Some(PermanentInfo {
                reason,
                http_status: extract_status(msg).unwrap_or(403),
            });
        }
    }
    // Substring fallback for the cases where Google's client flattens the
    // error into a free-form string. Mirrors `matchMessageReason`.
    if msg.contains("appNotAuthorizedToFile") {
        return Some(PermanentInfo {
            reason: PermanentReason::AppNotAuthorizedToFile,
            http_status: extract_status(msg).unwrap_or(403),
        });
    }
    if msg.contains("fileNotDownloadable") {
        return Some(PermanentInfo {
            reason: PermanentReason::FileNotDownloadable,
            http_status: extract_status(msg).unwrap_or(403),
        });
    }
    None
}

fn extract_reason_from_json_body(msg: &str) -> Option<String> {
    // Heuristic: find the first '{' and parse from there.
    let start = msg.find('{')?;
    let body: serde_json::Value = serde_json::from_str(msg.get(start..)?).ok()?;
    let reason = body
        .get("error")?
        .get("errors")?
        .as_array()?
        .first()?
        .get("reason")?
        .as_str()?
        .to_string();
    Some(reason)
}

fn extract_status(msg: &str) -> Option<u16> {
    // Match "HTTP <status>" — what `http_error` writes.
    let idx = msg.find("HTTP ")?;
    let tail = &msg[idx + 5..];
    let end = tail
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(tail.len());
    tail[..end].parse().ok()
}

pub fn format_marker(info: &PermanentInfo, message: &str) -> String {
    let first_line = message.lines().next().unwrap_or("");
    let trimmed: String = if first_line.chars().count() > 200 {
        let truncated: String = first_line.chars().take(197).collect();
        format!("{truncated}...")
    } else {
        first_line.to_string()
    };
    format!(
        "{PERMANENT_ERROR_PREFIX}{}] {trimmed}",
        info.reason.as_str(),
    )
}

pub fn is_permanent_marker(msg: &str) -> bool {
    msg.starts_with(PERMANENT_ERROR_PREFIX)
}

pub fn humanize(reason: PermanentReason) -> &'static str {
    match reason {
        PermanentReason::AppNotAuthorizedToFile => {
            "app not authorized to read this file (re-share with your account or see README troubleshooting)"
        }
        PermanentReason::Forbidden => "access forbidden by Drive",
        PermanentReason::FileNotDownloadable => "file is not downloadable via the API",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn err(message: &str) -> CliError {
        CliError::new(message, ErrorCode::Unknown)
    }

    #[test]
    fn classifies_structured_app_not_authorized() {
        let json = r#"{"error":{"code":403,"errors":[{"reason":"appNotAuthorizedToFile"}]}}"#;
        let e = err(&format!("files.get: HTTP 403: {json}"));
        let info = classify(&e).unwrap();
        assert_eq!(info.reason, PermanentReason::AppNotAuthorizedToFile);
        assert_eq!(info.http_status, 403);
    }

    #[test]
    fn classifies_unstructured_message_fallback() {
        let e = err("download failed: appNotAuthorizedToFile somewhere in this string");
        let info = classify(&e).unwrap();
        assert_eq!(info.reason, PermanentReason::AppNotAuthorizedToFile);
    }

    #[test]
    fn ignores_transient_errors() {
        let e = err("network timeout");
        assert!(classify(&e).is_none());
        let e2 = err("rate limited");
        assert!(classify(&e2).is_none());
    }

    #[test]
    fn formats_and_detects_marker() {
        let info = PermanentInfo {
            reason: PermanentReason::Forbidden,
            http_status: 403,
        };
        let marker = format_marker(&info, "access forbidden by Drive\nsecond line");
        assert_eq!(marker, "[permanent:forbidden] access forbidden by Drive");
        assert!(is_permanent_marker(&marker));
        assert!(!is_permanent_marker("plain error"));
    }

    #[test]
    fn truncates_long_messages_in_marker() {
        let info = PermanentInfo {
            reason: PermanentReason::Forbidden,
            http_status: 403,
        };
        let long = "x".repeat(300);
        let marker = format_marker(&info, &long);
        assert!(marker.starts_with("[permanent:forbidden] "));
        // 197 + 3 ellipsis + prefix
        assert!(marker.contains("..."));
    }
}
