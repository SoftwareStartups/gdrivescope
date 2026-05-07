//! Output emitter — JSON envelope on stdout when `--json` is active,
//! caller-provided human strings otherwise.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::models::ApiResponse;

static JSON_MODE: AtomicBool = AtomicBool::new(false);

pub fn set_json_mode(on: bool) {
    JSON_MODE.store(on, Ordering::Relaxed);
}

pub fn is_json_mode() -> bool {
    JSON_MODE.load(Ordering::Relaxed)
}

/// Emit a response. In JSON mode, serialize the envelope to stdout.
/// In human mode, defer to the supplied formatter for `Ok` data; print
/// `error: …` to stderr for `Err`.
pub fn emit<T: Serialize>(resp: &ApiResponse<T>, human: impl FnOnce(&T) -> String) {
    if is_json_mode() {
        match serde_json::to_string(resp) {
            Ok(s) => println!("{s}"),
            Err(e) => eprintln!("error: failed to serialize response: {e}"),
        }
        return;
    }
    match resp {
        ApiResponse::Ok(data) => println!("{}", human(data)),
        ApiResponse::Err { error, code } => eprintln!("error: {error} ({code})"),
    }
}
