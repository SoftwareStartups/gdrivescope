//! `LLM_SUMMARY_SCHEMA` JSON. Ported from `src/llm/summary-schema.ts`.

use serde_json::{json, Value};

use super::classification::CLASSIFICATION_VALUES;

/// Schema fed to providers as Anthropic tool input_schema, OpenAI/Azure
/// `response_format.json_schema`, or Ollama `format`. Same shape as the TS
/// constant — `{summary, classification, key_topics}` with the
/// classification enum and 1–10 key_topics constraint.
pub fn llm_summary_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "classification", "key_topics"],
        "properties": {
            "summary": { "type": "string", "minLength": 1 },
            "classification": { "type": "string", "enum": CLASSIFICATION_VALUES },
            "key_topics": {
                "type": "array",
                "items": { "type": "string" },
                "minItems": 1,
                "maxItems": 10,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_required_fields_match_ts() {
        let s = llm_summary_schema();
        let req: Vec<&str> = s["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(req, vec!["summary", "classification", "key_topics"]);
    }

    #[test]
    fn schema_enum_uses_classification_values() {
        let s = llm_summary_schema();
        let enum_arr: Vec<&str> = s["properties"]["classification"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(enum_arr, CLASSIFICATION_VALUES);
    }
}
