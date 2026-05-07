//! Compute the set of node ids that exist in the graph but were not seen on
//! the latest traversal — these are deletion candidates for `--prune`.
//! Direct port of `src/pipeline/pruning.ts`.

use std::collections::HashSet;

use crate::graph::model::DriveGraph;
use crate::graph::paths::descendants;

#[derive(Debug)]
pub struct PruneSetInput<'a> {
    pub graph: &'a DriveGraph,
    pub seen_ids: &'a HashSet<String>,
    /// Scope anchor — `None` prunes the entire graph.
    pub scope_id: Option<&'a str>,
}

pub fn compute_prune_set(input: PruneSetInput<'_>) -> Vec<String> {
    let candidates: Box<dyn Iterator<Item = String>> = match input.scope_id {
        None => Box::new(input.graph.nodes().map(|n| n.id.clone())),
        Some(scope) => Box::new(descendants(input.graph, scope).into_iter()),
    };
    candidates
        .filter(|id| !input.seen_ids.contains(id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::Node;

    fn n(id: &str, parent: Option<&str>) -> Node {
        Node {
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            name: id.to_string(),
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

    fn fixture() -> DriveGraph {
        let mut g = DriveGraph::new();
        g.add_node(n("root", None));
        g.add_node(n("a", Some("root")));
        g.add_node(n("b", Some("a")));
        g.add_node(n("c", Some("root")));
        g.add_edge("root", "a");
        g.add_edge("a", "b");
        g.add_edge("root", "c");
        g
    }

    #[test]
    fn prune_under_scope_returns_unseen_descendants() {
        let g = fixture();
        let seen: HashSet<String> = ["a"].iter().map(|s| s.to_string()).collect();
        let mut prune = compute_prune_set(PruneSetInput {
            graph: &g,
            seen_ids: &seen,
            scope_id: Some("root"),
        });
        prune.sort();
        // root is candidate via descendants(root) → includes root → ... actually
        // `descendants` excludes root itself, so candidates are {a,b,c}, minus seen {a}.
        assert_eq!(prune, vec!["b".to_string(), "c".to_string()]);
    }

    #[test]
    fn prune_global_includes_root() {
        let g = fixture();
        let seen: HashSet<String> = ["a", "b"].iter().map(|s| s.to_string()).collect();
        let mut prune = compute_prune_set(PruneSetInput {
            graph: &g,
            seen_ids: &seen,
            scope_id: None,
        });
        prune.sort();
        assert_eq!(prune, vec!["c".to_string(), "root".to_string()]);
    }

    #[test]
    fn prune_with_full_overlap_returns_empty() {
        let g = fixture();
        let seen: HashSet<String> = ["root", "a", "b", "c"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let prune = compute_prune_set(PruneSetInput {
            graph: &g,
            seen_ids: &seen,
            scope_id: None,
        });
        assert!(prune.is_empty());
    }
}
