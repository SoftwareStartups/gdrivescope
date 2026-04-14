import { type ApiResponse, fail } from '../models/api-response.js';

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'USAGE'
  | 'UNKNOWN_COMMAND'
  | 'NOT_IMPLEMENTED'
  | 'UNKNOWN';

export class CliError extends Error {
  readonly code: ErrorCode;
  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

export function toResponse(err: unknown): ApiResponse<never> {
  if (err instanceof CliError) {
    return fail(err.message, err.code);
  }
  if (err instanceof Error) {
    return fail(err.message, 'UNKNOWN');
  }
  return fail(String(err), 'UNKNOWN');
}
