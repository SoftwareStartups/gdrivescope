use serde::{ser::SerializeStruct, Serialize, Serializer};

use crate::error::{CliError, ErrorCode};

/// Output envelope. Serializes to:
///   `{"ok":true,"data":<T>}`
///   `{"ok":false,"error":<msg>,"code":<code>}`
///
/// Byte-equivalent to `ApiResponse<T>` in `src/models/api-response.ts`.
#[derive(Debug, Clone)]
pub enum ApiResponse<T> {
    Ok(T),
    Err { error: String, code: ErrorCode },
}

impl<T: Serialize> Serialize for ApiResponse<T> {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        match self {
            ApiResponse::Ok(data) => {
                let mut s = ser.serialize_struct("ApiResponse", 2)?;
                s.serialize_field("ok", &true)?;
                s.serialize_field("data", data)?;
                s.end()
            }
            ApiResponse::Err { error, code } => {
                let mut s = ser.serialize_struct("ApiResponse", 3)?;
                s.serialize_field("ok", &false)?;
                s.serialize_field("error", error)?;
                s.serialize_field("code", code)?;
                s.end()
            }
        }
    }
}

pub fn success<T>(data: T) -> ApiResponse<T> {
    ApiResponse::Ok(data)
}

pub fn fail<T>(error: impl Into<String>, code: ErrorCode) -> ApiResponse<T> {
    ApiResponse::Err {
        error: error.into(),
        code,
    }
}

/// Mirror of `toResponse(err)` in `src/utils/errors.ts`. Always returns the
/// error variant, with a free choice of `T` (TS `ApiResponse<never>`).
pub fn to_response<T>(err: &CliError) -> ApiResponse<T> {
    fail(err.message.clone(), err.code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_envelope_matches_ts_shape() {
        #[derive(Serialize)]
        struct Data {
            value: i32,
        }
        let resp = success(Data { value: 42 });
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(json, r#"{"ok":true,"data":{"value":42}}"#);
    }

    #[test]
    fn err_envelope_matches_ts_shape() {
        let resp: ApiResponse<()> = fail("nope", ErrorCode::AuthRequired);
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(
            json,
            r#"{"ok":false,"error":"nope","code":"AUTH_REQUIRED"}"#
        );
    }

    #[test]
    fn to_response_round_trip() {
        let err = CliError::new("boom", ErrorCode::ExtractFailed);
        let resp: ApiResponse<()> = to_response(&err);
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(
            json,
            r#"{"ok":false,"error":"boom","code":"EXTRACT_FAILED"}"#
        );
    }
}
