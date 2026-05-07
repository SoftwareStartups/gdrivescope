//! Filesystem path helpers.

use std::path::PathBuf;

use crate::error::{CliError, ErrorCode};

const APP_DIR: &str = "gdrivescope";

/// `~/.config/gdrivescope/` (XDG `$XDG_CONFIG_HOME/gdrivescope` on Linux,
/// `~/Library/Application Support/gdrivescope` on macOS, `%APPDATA%\\gdrivescope`
/// on Windows).
pub fn config_dir() -> Result<PathBuf, CliError> {
    let base = dirs::config_dir().ok_or_else(|| {
        CliError::new(
            "could not resolve user config directory",
            ErrorCode::Unknown,
        )
    })?;
    Ok(base.join(APP_DIR))
}

/// Path to the persistent SQLite database.
pub fn db_path() -> Result<PathBuf, CliError> {
    Ok(config_dir()?.join("drive.db"))
}
