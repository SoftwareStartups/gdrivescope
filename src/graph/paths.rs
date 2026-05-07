//! Path helpers — `node_path` and `descendants`. Pure functions over an
//! in-memory `DriveGraph`.

use std::collections::HashSet;

use super::model::DriveGraph;

/// Build a `/`-joined path by walking `parent_id` to a root. Returns
/// `<orphan>/<id>` for unknown ids, and prefixes `<orphan>/` when the
/// parent chain falls outside the graph; cycle detection short-circuits.
pub fn node_path(graph: &DriveGraph, id: &str) -> String {
    if !graph.has_node(id) {
        return format!("<orphan>/{id}");
    }
    let mut parts: Vec<String> = Vec::new();
    let mut guard: HashSet<String> = HashSet::new();
    let mut current = Some(id.to_string());
    while let Some(cur) = current {
        if guard.contains(&cur) {
            break;
        }
        guard.insert(cur.clone());
        let Some(node) = graph.get(&cur) else { break };
        parts.insert(0, node.name.clone());
        let Some(parent) = node.parent_id.as_deref() else {
            break;
        };
        if !graph.has_node(parent) {
            parts.insert(0, "<orphan>".to_string());
            break;
        }
        current = Some(parent.to_string());
    }
    parts.join("/")
}

/// Set of every descendant id under `root_id` (excluding `root_id` itself).
/// DFS over outgoing adjacency.
pub fn descendants(graph: &DriveGraph, root_id: &str) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::new();
    if !graph.has_node(root_id) {
        return out;
    }
    let mut stack: Vec<String> = vec![root_id.to_string()];
    while let Some(id) = stack.pop() {
        if !out.insert(id.clone()) {
            continue;
        }
        for child in graph.out_neighbors(&id) {
            stack.push(child.to_string());
        }
    }
    out.remove(root_id);
    out
}

#[cfg(test)]
mod tests {
    use super::super::model::Node;
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

    fn fixture() -> DriveGraph {
        // root → a → b
        //         ↘ c
        let mut g = DriveGraph::new();
        g.add_node(n("root", None, "root"));
        g.add_node(n("a", Some("root"), "a"));
        g.add_node(n("b", Some("a"), "b"));
        g.add_node(n("c", Some("a"), "c"));
        g.add_edge("root", "a");
        g.add_edge("a", "b");
        g.add_edge("a", "c");
        g
    }

    #[test]
    fn node_path_walks_parents() {
        let g = fixture();
        assert_eq!(node_path(&g, "b"), "root/a/b");
        assert_eq!(node_path(&g, "c"), "root/a/c");
        assert_eq!(node_path(&g, "root"), "root");
    }

    #[test]
    fn node_path_unknown_returns_orphan_sentinel() {
        let g = fixture();
        assert_eq!(node_path(&g, "missing"), "<orphan>/missing");
    }

    #[test]
    fn node_path_with_unreachable_parent_marks_orphan() {
        // Add a node whose parent_id points outside the graph.
        let mut g = DriveGraph::new();
        g.add_node(n("x", Some("ghost"), "x"));
        assert_eq!(node_path(&g, "x"), "<orphan>/x");
    }

    #[test]
    fn descendants_excludes_root() {
        let g = fixture();
        let ds = descendants(&g, "root");
        assert!(!ds.contains("root"));
        assert_eq!(ds.len(), 3);
        for id in ["a", "b", "c"] {
            assert!(ds.contains(id), "missing {id}");
        }
    }

    #[test]
    fn descendants_of_leaf_is_empty() {
        let g = fixture();
        assert!(descendants(&g, "b").is_empty());
    }

    #[test]
    fn descendants_of_unknown_is_empty() {
        let g = fixture();
        assert!(descendants(&g, "nope").is_empty());
    }
}
