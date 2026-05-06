//! Validate a raw provider response into an `LlmSummary`. Ported from
//! `src/llm/summary-parse.ts` — same lenient mapping (unknown classification
//! falls back to "other"; missing key_topics → empty list).

use super::classification::Classification;
use super::provider::LlmSummary;
use crate::error::{CliError, ErrorCode};

pub fn validate_raw_summary(
    provider: &str,
    raw: &serde_json::Value,
) -> Result<LlmSummary, CliError> {
    let obj = raw.as_object().ok_or_else(|| {
        CliError::new(
            format!("{provider} returned malformed output"),
            ErrorCode::LlmMalformedOutput,
        )
    })?;
    let summary = obj
        .get("summary")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            CliError::new(
                format!("{provider} response is missing required fields"),
                ErrorCode::LlmMalformedOutput,
            )
        })?
        .to_string();
    let classification = obj
        .get("classification")
        .and_then(|v| v.as_str())
        .map(Classification::from_str_lossy)
        .unwrap_or(Classification::Other);
    let key_topics: Vec<String> = obj
        .get("key_topics")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(LlmSummary {
        summary,
        classification,
        key_topics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_input_round_trips() {
        let json = serde_json::json!({
            "summary": "doc",
            "classification": "financial",
            "key_topics": ["a", "b"],
        });
        let s = validate_raw_summary("test", &json).unwrap();
        assert_eq!(s.summary, "doc");
        assert_eq!(s.classification, Classification::Financial);
        assert_eq!(s.key_topics, vec!["a", "b"]);
    }

    #[test]
    fn unknown_classification_maps_to_other() {
        let json = serde_json::json!({
            "summary": "doc",
            "classification": "unknown_kind",
            "key_topics": [],
        });
        let s = validate_raw_summary("test", &json).unwrap();
        assert_eq!(s.classification, Classification::Other);
    }

    #[test]
    fn missing_summary_errors() {
        let json = serde_json::json!({"classification": "other", "key_topics": []});
        let err = validate_raw_summary("test", &json).unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmMalformedOutput);
    }

    #[test]
    fn non_object_errors() {
        let json = serde_json::json!("a string");
        let err = validate_raw_summary("test", &json).unwrap_err();
        assert_eq!(err.code, ErrorCode::LlmMalformedOutput);
    }
}
