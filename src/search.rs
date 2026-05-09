//! Search over the indexed graph. Two modes:
//!
//! - `semantic_search`: kNN over the `embeddings` virtual table with
//!   post-filtering. Requires a populated embeddings table.
//! - `lexical_search`: substring match over name, computed path, mime type,
//!   `metadata_json`, and any non-null enrichment fields. Works with
//!   metadata-only indexes (no embedding provider needed).
//!
//! The CLI dispatcher chooses lexical when `embedding_dims` meta is absent,
//! and semantic otherwise.

use serde::{Deserialize, Serialize};

use crate::error::{CliError, ErrorCode};
use crate::graph::model::DriveGraph;
use crate::graph::paths::{descendants, node_path};
use crate::graph::store::Store;
use crate::llm::embedding::EmbeddingProvider;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Hit {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub path: String,
    pub score: f32,
    pub classification: Option<String>,
}

pub struct SemanticSearchOptions<'a> {
    pub query: &'a str,
    pub provider: &'a dyn EmbeddingProvider,
    pub store: &'a Store,
    pub graph: &'a DriveGraph,
    pub limit: Option<usize>,
    pub threshold: Option<f32>,
    pub scope: Option<&'a str>,
    pub classification: Option<&'a str>,
    /// Case-insensitive mime-type substring filter (e.g. `pdf`, `folder`).
    pub kind: Option<&'a str>,
}

pub async fn semantic_search(opts: SemanticSearchOptions<'_>) -> Result<Vec<Hit>, CliError> {
    let limit = opts.limit.unwrap_or(20).max(1);
    let threshold = opts.threshold.unwrap_or(0.0);

    if opts.store.get_meta("embedding_dims")?.is_none() {
        return Err(CliError::new(
            "No embeddings found. Run `gdrivescope index --scope X` first.",
            ErrorCode::NoEmbeddings,
        ));
    }

    let texts = vec![opts.query.to_string()];
    let mut vectors = opts.provider.embed(&texts).await?;
    let query_vec = vectors.pop().ok_or_else(|| {
        CliError::new(
            "Embedding provider returned no vectors for query.",
            ErrorCode::EmbedCallFailed,
        )
    })?;

    // Over-fetch so post-filters still leave room to hit `limit`.
    let k_oversample = limit * 3;
    let rows = opts.store.knn_search(&query_vec, k_oversample)?;

    let scope_set = opts.scope.map(|root| descendants(opts.graph, root));
    let kind_lc = opts.kind.map(|k| k.to_lowercase());

    let mut hits: Vec<Hit> = Vec::with_capacity(limit);
    for hit in rows {
        if let Some(set) = &scope_set {
            if !set.contains(&hit.node.id) {
                continue;
            }
        }
        if let Some(cls_filter) = opts.classification {
            if hit.node.classification.as_deref() != Some(cls_filter) {
                continue;
            }
        }
        if let Some(k) = &kind_lc {
            if !hit.node.mime_type.to_lowercase().contains(k.as_str()) {
                continue;
            }
        }
        let score = 1.0 - hit.distance;
        if score < threshold {
            continue;
        }
        let path = node_path(opts.graph, &hit.node.id);
        hits.push(Hit {
            id: hit.node.id,
            name: hit.node.name,
            mime_type: hit.node.mime_type,
            path,
            score,
            classification: hit.node.classification,
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

pub struct LexicalSearchOptions<'a> {
    pub query: &'a str,
    pub graph: &'a DriveGraph,
    pub limit: Option<usize>,
    pub threshold: Option<f32>,
    pub scope: Option<&'a str>,
    pub classification: Option<&'a str>,
    /// Case-insensitive mime-type substring filter (e.g. `pdf`, `folder`).
    pub kind: Option<&'a str>,
}

const W_NAME: f32 = 1.0;
const W_PATH: f32 = 0.6;
const W_SUMMARY: f32 = 0.5;
const W_KEY_TOPICS: f32 = 0.5;
const W_MIME: f32 = 0.4;
const W_METADATA: f32 = 0.3;
const W_EXTRACTED: f32 = 0.3;

const BONUS_EXACT_NAME: f32 = 0.5;
const BONUS_NAME_PREFIX: f32 = 0.2;
const BONUS_ALL_TOKENS_IN_NAME: f32 = 0.1;

/// Min token length required to match against `metadata_json`. Short tokens
/// against raw JSON keys/ids are too noisy.
const MIN_METADATA_TOKEN_LEN: usize = 3;

pub fn lexical_search(opts: LexicalSearchOptions<'_>) -> Result<Vec<Hit>, CliError> {
    let limit = opts.limit.unwrap_or(20).max(1);
    let threshold = opts.threshold.unwrap_or(0.0);

    let query_lc = opts.query.to_lowercase();
    let query_trimmed = query_lc.trim();
    let tokens: Vec<String> = query_trimmed
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    let token_count = tokens.len() as f32;

    let scope_set = opts.scope.map(|root| descendants(opts.graph, root));
    let kind_lc = opts.kind.map(|k| k.to_lowercase());

    let mut candidates: Vec<Hit> = Vec::new();
    let mut tiebreak: Vec<(Option<String>, String)> = Vec::new();

    'nodes: for node in opts.graph.nodes() {
        if let Some(set) = &scope_set {
            if !set.contains(&node.id) {
                continue;
            }
        }
        if let Some(c) = opts.classification {
            if node.classification.as_deref() != Some(c) {
                continue;
            }
        }
        let mime_lc = node.mime_type.to_lowercase();
        if let Some(k) = &kind_lc {
            if !mime_lc.contains(k.as_str()) {
                continue;
            }
        }

        let name_lc = node.name.to_lowercase();
        let path = node_path(opts.graph, &node.id);
        let path_lc = path.to_lowercase();
        let metadata_lc = node.metadata_json.to_lowercase();
        let summary_lc = node.summary.as_deref().map(str::to_lowercase);
        let key_topics_lc = node.key_topics.as_deref().map(str::to_lowercase);
        let extracted_lc = node.extracted_md.as_deref().map(str::to_lowercase);

        let mut total: f32 = 0.0;
        let mut all_in_name = true;

        for token in &tokens {
            let t = token.as_str();
            let mut best: f32 = 0.0;

            if name_lc.contains(t) {
                best = W_NAME;
            } else {
                all_in_name = false;
            }
            if best < W_PATH && path_lc.contains(t) {
                best = W_PATH;
            }
            if best < W_SUMMARY {
                if let Some(s) = &summary_lc {
                    if s.contains(t) {
                        best = W_SUMMARY;
                    }
                }
            }
            if best < W_KEY_TOPICS {
                if let Some(s) = &key_topics_lc {
                    if s.contains(t) {
                        best = W_KEY_TOPICS;
                    }
                }
            }
            if best < W_MIME && mime_lc.contains(t) {
                best = W_MIME;
            }
            if best < W_METADATA && t.len() >= MIN_METADATA_TOKEN_LEN && metadata_lc.contains(t) {
                best = W_METADATA;
            }
            if best < W_EXTRACTED {
                if let Some(s) = &extracted_lc {
                    if s.contains(t) {
                        best = W_EXTRACTED;
                    }
                }
            }

            if best == 0.0 {
                continue 'nodes;
            }
            total += best;
        }

        let mut score = total / token_count;
        if name_lc == query_trimmed {
            score += BONUS_EXACT_NAME;
        } else if name_lc.starts_with(query_trimmed) {
            score += BONUS_NAME_PREFIX;
        }
        if all_in_name {
            score += BONUS_ALL_TOKENS_IN_NAME;
        }
        if score > 1.0 {
            score = 1.0;
        }
        if score < threshold {
            continue;
        }

        tiebreak.push((node.modified_time.clone(), node.id.clone()));
        candidates.push(Hit {
            id: node.id.clone(),
            name: node.name.clone(),
            mime_type: node.mime_type.clone(),
            path,
            score,
            classification: node.classification.clone(),
        });
    }

    let mut indices: Vec<usize> = (0..candidates.len()).collect();
    indices.sort_by(|&a, &b| {
        candidates[b]
            .score
            .partial_cmp(&candidates[a].score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| tiebreak[b].0.cmp(&tiebreak[a].0))
            .then_with(|| tiebreak[a].1.cmp(&tiebreak[b].1))
    });

    let hits: Vec<Hit> = indices
        .into_iter()
        .take(limit)
        .map(|i| candidates[i].clone())
        .collect();
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::{DriveNodeInput, Node};
    use async_trait::async_trait;

    fn drive_input(id: &str, parent: Option<&str>, name: &str) -> DriveNodeInput {
        DriveNodeInput {
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            name: name.to_string(),
            mime_type: "application/pdf".to_string(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: None,
            metadata: serde_json::Map::new(),
        }
    }

    /// Stub embedding provider returning a fixed unit vector — fine for the
    /// post-filter / scoring tests since we don't exercise actual similarity.
    struct StubEmbedding {
        dims: usize,
    }

    #[async_trait]
    impl EmbeddingProvider for StubEmbedding {
        fn name(&self) -> &str {
            "stub"
        }
        fn dimensions(&self) -> usize {
            self.dims
        }
        async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CliError> {
            // First component = 1.0, rest 0.0.
            Ok(texts
                .iter()
                .map(|_| {
                    let mut v = vec![0.0_f32; self.dims];
                    v[0] = 1.0;
                    v
                })
                .collect())
        }
    }

    #[tokio::test]
    async fn errors_when_no_embeddings_table() {
        let store = Store::open_in_memory().unwrap();
        let graph = DriveGraph::new();
        let provider = StubEmbedding { dims: 4 };
        let err = semantic_search(SemanticSearchOptions {
            query: "test",
            provider: &provider,
            store: &store,
            graph: &graph,
            limit: None,
            threshold: None,
            scope: None,
            classification: None,
            kind: None,
        })
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::NoEmbeddings);
    }

    #[tokio::test]
    async fn returns_hits_within_limit() {
        let store = Store::open_in_memory().unwrap();
        store.init_vector_table(4, false).unwrap();
        let mut graph = DriveGraph::new();
        for (id, vec) in [
            ("a", [1.0_f32, 0.0, 0.0, 0.0]),
            ("b", [0.5_f32, 0.5, 0.0, 0.0]),
            ("c", [0.0_f32, 1.0, 0.0, 0.0]),
        ] {
            store.upsert_node(&drive_input(id, None, id)).unwrap();
            store.upsert_embedding(id, &vec).unwrap();
            let n = store.get_node(id).unwrap().unwrap();
            graph.add_node(Node { ..n });
        }
        let provider = StubEmbedding { dims: 4 };
        let hits = semantic_search(SemanticSearchOptions {
            query: "test",
            provider: &provider,
            store: &store,
            graph: &graph,
            limit: Some(2),
            threshold: None,
            scope: None,
            classification: None,
            kind: None,
        })
        .await
        .unwrap();
        assert_eq!(hits.len(), 2);
        // Closest under cosine to [1,0,0,0] is "a".
        assert_eq!(hits[0].id, "a");
    }

    #[tokio::test]
    async fn threshold_filters_low_scores() {
        let store = Store::open_in_memory().unwrap();
        store.init_vector_table(4, false).unwrap();
        let mut graph = DriveGraph::new();
        for (id, vec) in [
            ("a", [1.0_f32, 0.0, 0.0, 0.0]),
            ("c", [0.0_f32, 1.0, 0.0, 0.0]),
        ] {
            store.upsert_node(&drive_input(id, None, id)).unwrap();
            store.upsert_embedding(id, &vec).unwrap();
            let n = store.get_node(id).unwrap().unwrap();
            graph.add_node(Node { ..n });
        }
        let provider = StubEmbedding { dims: 4 };
        // Score for "c" against query [1,0,0,0] is 0.0 (orthogonal).
        // With threshold=0.5, only "a" should pass.
        let hits = semantic_search(SemanticSearchOptions {
            query: "test",
            provider: &provider,
            store: &store,
            graph: &graph,
            limit: Some(10),
            threshold: Some(0.5),
            scope: None,
            classification: None,
            kind: None,
        })
        .await
        .unwrap();
        assert!(hits.iter().any(|h| h.id == "a"));
        assert!(!hits.iter().any(|h| h.id == "c"));
    }

    #[tokio::test]
    async fn semantic_kind_substring_filter() {
        let store = Store::open_in_memory().unwrap();
        store.init_vector_table(4, false).unwrap();
        let mut graph = DriveGraph::new();

        let pdf = DriveNodeInput {
            id: "p".into(),
            parent_id: None,
            name: "p".into(),
            mime_type: "application/pdf".into(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: None,
            metadata: serde_json::Map::new(),
        };
        let doc = DriveNodeInput {
            id: "d".into(),
            parent_id: None,
            name: "d".into(),
            mime_type: "application/vnd.google-apps.document".into(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: None,
            metadata: serde_json::Map::new(),
        };
        store.upsert_node(&pdf).unwrap();
        store.upsert_node(&doc).unwrap();
        store
            .upsert_embedding("p", &[1.0_f32, 0.0, 0.0, 0.0])
            .unwrap();
        store
            .upsert_embedding("d", &[0.9_f32, 0.1, 0.0, 0.0])
            .unwrap();
        graph.add_node(Node {
            ..store.get_node("p").unwrap().unwrap()
        });
        graph.add_node(Node {
            ..store.get_node("d").unwrap().unwrap()
        });

        let provider = StubEmbedding { dims: 4 };
        let hits = semantic_search(SemanticSearchOptions {
            query: "anything",
            provider: &provider,
            store: &store,
            graph: &graph,
            limit: Some(10),
            threshold: None,
            scope: None,
            classification: None,
            kind: Some("pdf"),
        })
        .await
        .unwrap();
        assert!(hits.iter().any(|h| h.id == "p"));
        assert!(!hits.iter().any(|h| h.id == "d"));
    }

    fn make_node(id: &str, parent: Option<&str>, name: &str, mime: &str) -> Node {
        Node {
            id: id.into(),
            parent_id: parent.map(Into::into),
            name: name.into(),
            mime_type: mime.into(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: None,
            metadata_json: "{}".into(),
            summary: None,
            classification: None,
            key_topics: None,
            extracted_md: None,
            content_hash: None,
            last_embedded_hash: None,
            last_indexed: None,
            last_error: None,
            summary_modified_time: None,
        }
    }

    fn lex_opts<'a>(query: &'a str, graph: &'a DriveGraph) -> LexicalSearchOptions<'a> {
        LexicalSearchOptions {
            query,
            graph,
            limit: None,
            threshold: None,
            scope: None,
            classification: None,
            kind: None,
        }
    }

    #[test]
    fn lexical_matches_by_name() {
        let mut g = DriveGraph::new();
        g.add_node(make_node("a", None, "Q1 Report.pdf", "application/pdf"));
        g.add_node(make_node("b", None, "Notes.txt", "text/plain"));
        let hits = lexical_search(lex_opts("report", &g)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
    }

    #[test]
    fn lexical_matches_by_path_segment() {
        let mut g = DriveGraph::new();
        g.add_node(make_node(
            "root",
            None,
            "Invoices",
            "application/vnd.google-apps.folder",
        ));
        g.add_node(make_node("f", Some("root"), "june.pdf", "application/pdf"));
        g.add_edge("root", "f");
        let hits = lexical_search(lex_opts("invoices", &g)).unwrap();
        // Both the folder (name match) and the file (path match) qualify.
        assert!(hits.iter().any(|h| h.id == "f"));
        assert!(hits.iter().any(|h| h.id == "root"));
    }

    #[test]
    fn lexical_matches_by_mime() {
        let mut g = DriveGraph::new();
        g.add_node(make_node(
            "f",
            None,
            "x",
            "application/vnd.google-apps.folder",
        ));
        g.add_node(make_node("p", None, "y", "application/pdf"));
        let hits = lexical_search(lex_opts("folder", &g)).unwrap();
        assert!(hits.iter().any(|h| h.id == "f"));
        assert!(!hits.iter().any(|h| h.id == "p"));
    }

    #[test]
    fn lexical_matches_metadata_json() {
        let mut g = DriveGraph::new();
        let mut n = make_node("m", None, "untitled", "application/pdf");
        n.metadata_json = r#"{"owners":[{"emailAddress":"alice@example.com"}]}"#.into();
        g.add_node(n);
        let hits = lexical_search(lex_opts("alice", &g)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "m");
    }

    #[test]
    fn lexical_requires_all_tokens() {
        let mut g = DriveGraph::new();
        g.add_node(make_node("a", None, "alpha bravo", "application/pdf"));
        g.add_node(make_node("b", None, "alpha only", "application/pdf"));
        let hits = lexical_search(lex_opts("alpha bravo", &g)).unwrap();
        assert!(hits.iter().any(|h| h.id == "a"));
        assert!(!hits.iter().any(|h| h.id == "b"));
    }

    #[test]
    fn lexical_short_token_skips_metadata_json() {
        let mut g = DriveGraph::new();
        let mut n = make_node("m", None, "report", "application/pdf");
        // "id" is a 2-char token only present in metadata_json.
        n.metadata_json = r#"{"id":"abc"}"#.into();
        g.add_node(n);
        // Two-char "id" must not match metadata_json. But it is present in
        // the path segment and in the mime "application/pdf" → no, neither
        // contains "id". And the name "report" does not contain "id".
        // So search for "id" must return empty.
        let hits = lexical_search(lex_opts("id", &g)).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn lexical_scope_filter_excludes_outside() {
        let mut g = DriveGraph::new();
        g.add_node(make_node(
            "root",
            None,
            "root",
            "application/vnd.google-apps.folder",
        ));
        g.add_node(make_node(
            "inside",
            Some("root"),
            "report A",
            "application/pdf",
        ));
        g.add_node(make_node("outside", None, "report B", "application/pdf"));
        g.add_edge("root", "inside");
        let opts = LexicalSearchOptions {
            scope: Some("root"),
            ..lex_opts("report", &g)
        };
        let hits = lexical_search(opts).unwrap();
        assert!(hits.iter().any(|h| h.id == "inside"));
        assert!(!hits.iter().any(|h| h.id == "outside"));
    }

    #[test]
    fn lexical_classification_filter() {
        let mut g = DriveGraph::new();
        let mut a = make_node("a", None, "report a", "application/pdf");
        a.classification = Some("invoice".into());
        let mut b = make_node("b", None, "report b", "application/pdf");
        b.classification = Some("memo".into());
        g.add_node(a);
        g.add_node(b);
        let opts = LexicalSearchOptions {
            classification: Some("invoice"),
            ..lex_opts("report", &g)
        };
        let hits = lexical_search(opts).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
    }

    #[test]
    fn lexical_kind_substring_filter() {
        let mut g = DriveGraph::new();
        g.add_node(make_node("p", None, "x", "application/pdf"));
        g.add_node(make_node(
            "d",
            None,
            "x",
            "application/vnd.google-apps.document",
        ));
        let opts = LexicalSearchOptions {
            kind: Some("pdf"),
            ..lex_opts("x", &g)
        };
        let hits = lexical_search(opts).unwrap();
        assert!(hits.iter().any(|h| h.id == "p"));
        assert!(!hits.iter().any(|h| h.id == "d"));
    }

    #[test]
    fn lexical_ranking_prefers_name_over_metadata() {
        let mut g = DriveGraph::new();
        g.add_node(make_node("name", None, "alpha report", "application/pdf"));
        let mut meta = make_node("meta", None, "untitled", "application/pdf");
        meta.metadata_json = r#"{"description":"alpha"}"#.into();
        g.add_node(meta);
        let hits = lexical_search(lex_opts("alpha", &g)).unwrap();
        assert_eq!(hits[0].id, "name");
    }

    #[test]
    fn lexical_exact_name_match_bonus() {
        let mut g = DriveGraph::new();
        g.add_node(make_node("exact", None, "Report", "application/pdf"));
        g.add_node(make_node(
            "longer",
            None,
            "Report Quarterly",
            "application/pdf",
        ));
        let hits = lexical_search(lex_opts("Report", &g)).unwrap();
        assert_eq!(hits[0].id, "exact");
    }

    #[test]
    fn lexical_limit_caps_results() {
        let mut g = DriveGraph::new();
        for i in 0..5 {
            g.add_node(make_node(
                &format!("n{i}"),
                None,
                &format!("doc {i}"),
                "application/pdf",
            ));
        }
        let opts = LexicalSearchOptions {
            limit: Some(2),
            ..lex_opts("doc", &g)
        };
        let hits = lexical_search(opts).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn lexical_empty_workspace_returns_empty() {
        let g = DriveGraph::new();
        let hits = lexical_search(lex_opts("anything", &g)).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn lexical_whitespace_query_returns_empty() {
        let mut g = DriveGraph::new();
        g.add_node(make_node("a", None, "anything", "application/pdf"));
        let hits = lexical_search(lex_opts("   ", &g)).unwrap();
        assert!(hits.is_empty());
    }
}
