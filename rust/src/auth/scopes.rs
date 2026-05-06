//! Drive OAuth scope constants + hierarchy. Ported from `src/auth/scopes.ts`.
//!
//! Hierarchy is one-directional: `drive.readonly` (full) implies
//! `drive.metadata.readonly`. The reverse never holds. This means a session
//! authorized for the broader scope does NOT need to re-login when a narrower
//! one is required, which is what users expect (see auth-scope-hierarchy
//! preference in saved feedback).

use crate::error::{CliError, ErrorCode};

pub const SCOPE_METADATA: &str = "https://www.googleapis.com/auth/drive.metadata.readonly";
pub const SCOPE_FULL: &str = "https://www.googleapis.com/auth/drive.readonly";

/// Short-form alias used in error messages — matches the `--scope` flag value
/// the user would re-enter.
fn short_name(scope: &str) -> &str {
    match scope {
        SCOPE_METADATA => "drive.metadata.readonly",
        SCOPE_FULL => "drive.readonly",
        other => other,
    }
}

/// Returns true iff `granted` (a slice of granted scope URIs) satisfies
/// the `required` scope, accounting for the implication graph.
pub fn satisfies(granted: &[&str], required: &str) -> bool {
    if granted.contains(&required) {
        return true;
    }
    // SCOPE_FULL implies SCOPE_METADATA.
    if required == SCOPE_METADATA && granted.contains(&SCOPE_FULL) {
        return true;
    }
    false
}

/// Build the user-facing "you need scope X — re-run login" error.
pub fn scope_required_error(required: &str) -> CliError {
    CliError::new(
        format!(
            "This command needs {}. Re-run `gdrivescope login --scope {}`.",
            short_name(required),
            short_name(required),
        ),
        ErrorCode::ScopeRequired,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match_satisfies() {
        assert!(satisfies(&[SCOPE_METADATA], SCOPE_METADATA));
        assert!(satisfies(&[SCOPE_FULL], SCOPE_FULL));
    }

    #[test]
    fn full_implies_metadata() {
        // Broader-than-required must satisfy: full readonly satisfies
        // metadata-only requirement without re-login.
        assert!(satisfies(&[SCOPE_FULL], SCOPE_METADATA));
    }

    #[test]
    fn metadata_does_not_imply_full() {
        // The reverse must NOT hold — narrow can't satisfy broad.
        assert!(!satisfies(&[SCOPE_METADATA], SCOPE_FULL));
    }

    #[test]
    fn empty_grants_never_satisfy() {
        assert!(!satisfies(&[], SCOPE_METADATA));
        assert!(!satisfies(&[], SCOPE_FULL));
    }

    #[test]
    fn unknown_scopes_pass_through_exact_match() {
        let custom = "https://www.googleapis.com/auth/custom";
        assert!(satisfies(&[custom], custom));
        assert!(!satisfies(&[SCOPE_FULL], custom));
    }
}
