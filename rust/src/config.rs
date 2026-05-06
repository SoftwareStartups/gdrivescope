//! TOML workspace config. Full TOML parsing arrives in Phase 7; for now
//! we expose just the small `ConfigRoot` shape that the Drive ancestry
//! port (Phase 4) needs.

use serde::{Deserialize, Serialize};

/// One configured Drive root. Mirrors the `[[roots]]` entries in
/// `~/.config/gdrivescope/config.toml`. Phase 7 lifts the loader.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigRoot {
    /// Drive folder id, or the literal `"root"` sentinel for My Drive.
    pub id: String,
    /// Optional display label override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
