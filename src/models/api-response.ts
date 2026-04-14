export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };

export function success<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

export function fail(error: string, code: string): ApiResponse<never> {
  return { ok: false, error, code };
}
