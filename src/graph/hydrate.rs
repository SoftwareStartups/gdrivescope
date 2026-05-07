//! Rebuild the in-memory `DriveGraph` from persisted nodes. Direct port of
//! `src/graph/hydrate.ts` — two passes: insert all nodes, then connect edges
//! against still-existing parents.

use super::model::DriveGraph;
use super::store::Store;
use crate::error::CliError;

pub fn hydrate_graph(store: &Store) -> Result<DriveGraph, CliError> {
    let mut graph = DriveGraph::new();
    let nodes = store.all_nodes()?;
    for node in &nodes {
        graph.add_node(node.clone());
    }
    for node in &nodes {
        if let Some(parent_id) = node.parent_id.as_deref() {
            if graph.has_node(parent_id) {
                graph.add_edge(parent_id, &node.id);
            }
        }
    }
    Ok(graph)
}

#[cfg(test)]
mod tests {
    use super::super::model::DriveNodeInput;
    use super::super::paths::descendants;
    use super::*;

    fn input(id: &str, parent: Option<&str>, name: &str) -> DriveNodeInput {
        DriveNodeInput {
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            name: name.to_string(),
            mime_type: "application/vnd.google-apps.folder".to_string(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: None,
            metadata: serde_json::Map::new(),
        }
    }

    #[test]
    fn hydrate_reconstructs_parent_edges() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_node(&input("root", None, "root")).unwrap();
        store.upsert_node(&input("a", Some("root"), "a")).unwrap();
        store.upsert_node(&input("b", Some("a"), "b")).unwrap();

        let graph = hydrate_graph(&store).unwrap();
        assert_eq!(graph.len(), 3);
        let kids: Vec<&str> = graph.out_neighbors("root").collect();
        assert_eq!(kids, vec!["a"]);
        let descs = descendants(&graph, "root");
        assert!(descs.contains("a"));
        assert!(descs.contains("b"));
    }

    #[test]
    fn hydrate_skips_orphan_parent_edges() {
        let store = Store::open_in_memory().unwrap();
        // "x" claims to have parent "ghost" which isn't in the DB.
        store.upsert_node(&input("x", Some("ghost"), "x")).unwrap();
        let graph = hydrate_graph(&store).unwrap();
        assert!(graph.has_node("x"));
        // No edge created since ghost isn't in the graph.
        assert_eq!(graph.out_neighbors("ghost").count(), 0);
    }

    #[test]
    fn hydrate_handles_out_of_order_inserts() {
        let store = Store::open_in_memory().unwrap();
        // Child inserted before parent.
        store
            .upsert_node(&input("child", Some("parent"), "c"))
            .unwrap();
        store.upsert_node(&input("parent", None, "p")).unwrap();
        let graph = hydrate_graph(&store).unwrap();
        let kids: Vec<&str> = graph.out_neighbors("parent").collect();
        assert_eq!(kids, vec!["child"]);
    }
}
