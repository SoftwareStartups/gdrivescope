//! Static prompt strings + `summary_user` builder used by every LLM
//! provider's `summarize` call.

pub const SUMMARY_SYSTEM: &str = "You are a document classifier and summarizer. Respond in English regardless of the document's source language. Classification must be exactly one of the allowed values.";

pub const SUMMARY_USER_SNIPPET_CHARS: usize = 3000;

/// Build the user-message body. Truncates `markdown` at
/// `SUMMARY_USER_SNIPPET_CHARS` chars (not bytes — never splits a multi-byte
/// codepoint).
pub fn summary_user(filename: &str, path: &str, markdown: &str) -> String {
    let snippet: String = markdown.chars().take(SUMMARY_USER_SNIPPET_CHARS).collect();
    format!("Filename: {filename}\nPath: {path}\n\nContent:\n{snippet}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_contains_metadata_and_snippet() {
        let s = summary_user("doc.pdf", "root/sub/doc.pdf", "hello world");
        assert!(s.contains("Filename: doc.pdf"));
        assert!(s.contains("Path: root/sub/doc.pdf"));
        assert!(s.contains("hello world"));
    }

    #[test]
    fn user_message_truncates_long_content() {
        let big: String = "x".repeat(SUMMARY_USER_SNIPPET_CHARS + 1000);
        let s = summary_user("a", "b", &big);
        // Chars in snippet section after "Content:\n" should be exactly the cap.
        let after = s.split_once("Content:\n").unwrap().1;
        assert_eq!(after.chars().count(), SUMMARY_USER_SNIPPET_CHARS);
    }
}
