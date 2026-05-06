//! Vector search. Direct port of `src/search/vector-search.ts`.
//! kNN over `embeddings` virtual table, 3× over-fetch, post-filter by
//! scope (descendants of a folder), classification, and threshold.

use serde::{Deserialize, Serialize};

use crate::error::{CliError, ErrorCode};
use crate::graph::model::DriveGraph;
use crate::graph::paths::{descendants, node_path};
use crate::graph::store::Store;
use crate::llm::embedding::EmbeddingProvider;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
        })
        .await
        .unwrap();
        assert!(hits.iter().any(|h| h.id == "a"));
        assert!(!hits.iter().any(|h| h.id == "c"));
    }
}
