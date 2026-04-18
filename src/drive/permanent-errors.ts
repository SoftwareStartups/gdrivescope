// Classifies Google Drive API errors into "permanent" (retrying won't help)
// and "transient" (retrying on --resume may succeed). Permanent failures are
// stored in nodes.last_error with a PERMANENT_ERROR_PREFIX marker so that
// buildWorkList() skips them on subsequent --resume runs.

export type PermanentErrorReason =
  | 'appNotAuthorizedToFile'
  | 'forbidden'
  | 'fileNotDownloadable';

export interface PermanentErrorInfo {
  permanent: true;
  reason: PermanentErrorReason;
  httpStatus: number;
}

export const PERMANENT_ERROR_PREFIX = '[permanent:';

const PERMANENT_REASONS: ReadonlySet<PermanentErrorReason> = new Set([
  'appNotAuthorizedToFile',
  'forbidden',
  'fileNotDownloadable',
]);

interface GoogleErrorDetail {
  reason?: string;
}
interface GoogleErrorBody {
  code?: number;
  errors?: GoogleErrorDetail[];
}
interface GaxiosLikeShape {
  response?: { data?: { error?: GoogleErrorBody } };
  code?: number | string;
  status?: number;
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readStructured(err: unknown): {
  reason: string | null;
  status: number | null;
} {
  const root = asRecord(err);
  if (!root) return { reason: null, status: null };
  const shape = root as unknown as GaxiosLikeShape;
  const body = shape.response?.data?.error;
  const detail = body?.errors?.[0];
  const reason = typeof detail?.reason === 'string' ? detail.reason : null;
  const status =
    typeof body?.code === 'number'
      ? body.code
      : typeof shape.status === 'number'
        ? shape.status
        : typeof shape.code === 'number'
          ? shape.code
          : null;
  return { reason, status };
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// Google's client occasionally flattens its error body into the message
// string (JSON-stringified). Fall back to a regex so we still catch the
// permanent reason when the structured shape is missing.
function matchMessageReason(message: string): PermanentErrorReason | null {
  if (message.includes('appNotAuthorizedToFile'))
    return 'appNotAuthorizedToFile';
  if (message.includes('fileNotDownloadable')) return 'fileNotDownloadable';
  return null;
}

export function classifyDriveError(err: unknown): PermanentErrorInfo | null {
  const { reason, status } = readStructured(err);
  if (reason && PERMANENT_REASONS.has(reason as PermanentErrorReason)) {
    return {
      permanent: true,
      reason: reason as PermanentErrorReason,
      httpStatus: status ?? 403,
    };
  }

  const message = readMessage(err);
  const matched = matchMessageReason(message);
  if (matched) {
    return { permanent: true, reason: matched, httpStatus: status ?? 403 };
  }
  return null;
}

export function isPermanentErrorMessage(msg: string | null): boolean {
  return msg?.startsWith(PERMANENT_ERROR_PREFIX) ?? false;
}

export function formatPermanentError(
  info: PermanentErrorInfo,
  message: string
): string {
  const firstLine = message.split('\n', 1)[0] ?? '';
  const trimmed =
    firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
  return `${PERMANENT_ERROR_PREFIX}${info.reason}] ${trimmed}`;
}

const HUMAN_REASONS: Record<PermanentErrorReason, string> = {
  appNotAuthorizedToFile:
    'app not authorized to read this file (re-share with your account or see README troubleshooting)',
  forbidden: 'access forbidden by Drive',
  fileNotDownloadable: 'file is not downloadable via the API',
};

export function humanizePermanentReason(reason: PermanentErrorReason): string {
  return HUMAN_REASONS[reason];
}
