use crate::error::{CliError, ErrorCode};

pub async fn execute() -> Result<(), CliError> {
    Err(CliError::new(
        "logout: not yet implemented (Phase 3)",
        ErrorCode::NotYetImplemented,
    ))
}
