//! In-memory Drive graph + node types. Replaces graphology with a hand-rolled
//! adjacency-list graph since the TS code only uses
//! `addNode`/`hasNode`/`addEdge`/`getNodeAttributes`/`outNeighbors`. Ported
//! from `src/graph/model.ts` (types) and the implicit operations exercised
//! by `hydrate.ts` and `paths.ts`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Mirrors `Node` in `src/graph/model.ts`. Kept JSON-shape identical so
/// commands like `show --json` produce the same envelope payload as TS.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_view_link: Option<String>,
    pub root_id: Option<String>,
    pub metadata_json: String,
    pub summary: Option<String>,
    pub classification: Option<String>,
    pub key_topics: Option<String>,
    pub extracted_md: Option<String>,
    pub content_hash: Option<String>,
    pub last_embedded_hash: Option<String>,
    pub last_indexed: Option<String>,
    pub last_error: Option<String>,
}

/// Mirrors `DriveNodeInput`. Used as the upsert payload from drive traversal.
#[derive(Debug, Clone)]
pub struct DriveNodeInput {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub mime_type: String,
    pub size: Option<u64>,
    pub modified_time: Option<String>,
    pub created_time: Option<String>,
    pub web_view_link: Option<String>,
    pub root_id: Option<String>,
    /// Additional Drive metadata serialized to JSON before persistence.
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

/// Hand-rolled directed graph. Edges are derived from `parent_id` (one parent
/// per node), so we store an outgoing-adjacency map keyed by parent id.
#[derive(Debug, Default, Clone)]
pub struct DriveGraph {
    nodes: HashMap<String, Node>,
    /// parent_id → ordered list of child ids
    out_adj: HashMap<String, Vec<String>>,
}

impl DriveGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn has_node(&self, id: &str) -> bool {
        self.nodes.contains_key(id)
    }

    pub fn get(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    /// Insert or replace a node. Edges into/out of this node are unchanged.
    pub fn add_node(&mut self, node: Node) {
        self.nodes.insert(node.id.clone(), node);
    }

    /// Add a directed edge `parent → child`. No-op if the edge already exists
    /// (graphology errors on duplicates; we silently dedupe to keep
    /// `hydrate` simple). Endpoints must be present — debug builds assert.
    pub fn add_edge(&mut self, parent: &str, child: &str) {
        debug_assert!(
            self.nodes.contains_key(parent),
            "add_edge: parent {parent} not in graph"
        );
        debug_assert!(
            self.nodes.contains_key(child),
            "add_edge: child {child} not in graph"
        );
        let bucket = self.out_adj.entry(parent.to_string()).or_default();
        if !bucket.iter().any(|c| c == child) {
            bucket.push(child.to_string());
        }
    }

    /// Children of `id` in insertion order.
    pub fn out_neighbors(&self, id: &str) -> impl Iterator<Item = &str> {
        self.out_adj
            .get(id)
            .into_iter()
            .flat_map(|v| v.iter().map(String::as_str))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(id: &str, parent: Option<&str>, name: &str) -> Node {
        Node {
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            name: name.to_string(),
            mime_type: "application/vnd.google-apps.folder".to_string(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: None,
            metadata_json: "{}".to_string(),
            summary: None,
            classification: None,
            key_topics: None,
            extracted_md: None,
            content_hash: None,
            last_embedded_hash: None,
            last_indexed: None,
            last_error: None,
        }
    }

    #[test]
    fn add_node_get_has() {
        let mut g = DriveGraph::new();
        assert!(!g.has_node("a"));
        g.add_node(n("a", None, "root"));
        assert!(g.has_node("a"));
        assert_eq!(g.get("a").unwrap().name, "root");
        assert_eq!(g.len(), 1);
    }

    #[test]
    fn add_edge_and_neighbors() {
        let mut g = DriveGraph::new();
        g.add_node(n("a", None, "root"));
        g.add_node(n("b", Some("a"), "child1"));
        g.add_node(n("c", Some("a"), "child2"));
        g.add_edge("a", "b");
        g.add_edge("a", "c");
        let kids: Vec<&str> = g.out_neighbors("a").collect();
        assert_eq!(kids, vec!["b", "c"]);
    }

    #[test]
    fn duplicate_edges_are_deduped() {
        let mut g = DriveGraph::new();
        g.add_node(n("a", None, "root"));
        g.add_node(n("b", Some("a"), "child"));
        g.add_edge("a", "b");
        g.add_edge("a", "b");
        let kids: Vec<&str> = g.out_neighbors("a").collect();
        assert_eq!(kids, vec!["b"]);
    }

    #[test]
    fn out_neighbors_of_unknown_id_is_empty() {
        let g = DriveGraph::new();
        assert_eq!(g.out_neighbors("nope").count(), 0);
    }

    #[test]
    fn node_serialization_uses_camelcase() {
        let node = n("a", Some("b"), "foo");
        let json = serde_json::to_string(&node).unwrap();
        // Required fields land in camelCase, optional empties stay omitted.
        assert!(json.contains(r#""parentId":"b""#));
        assert!(json.contains(r#""mimeType":"application/vnd.google-apps.folder""#));
        assert!(json.contains(r#""metadataJson":"{}""#));
        assert!(json.contains(r#""rootId":null"#));
        assert!(!json.contains(r#""size""#)); // skipped because None
    }
}
