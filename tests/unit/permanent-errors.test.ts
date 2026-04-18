import { describe, expect, test } from 'bun:test';
import {
  classifyDriveError,
  formatPermanentError,
  humanizePermanentReason,
  isPermanentErrorMessage,
  PERMANENT_ERROR_PREFIX,
} from '../../src/drive/permanent-errors.js';

function gaxiosShape(
  reason: string,
  code = 403,
  message = `${code} ${reason}`
): Error & {
  response: { data: { error: { code: number; errors: [{ reason: string }] } } };
} {
  const err = new Error(message) as Error & {
    response: {
      data: { error: { code: number; errors: [{ reason: string }] } };
    };
  };
  err.response = {
    data: { error: { code, errors: [{ reason }] } },
  };
  return err;
}

describe('classifyDriveError — structured shape', () => {
  test('classifies appNotAuthorizedToFile 403 as permanent', () => {
    const info = classifyDriveError(gaxiosShape('appNotAuthorizedToFile'));
    expect(info).toEqual({
      permanent: true,
      reason: 'appNotAuthorizedToFile',
      httpStatus: 403,
    });
  });

  test('classifies fileNotDownloadable 403 as permanent', () => {
    const info = classifyDriveError(gaxiosShape('fileNotDownloadable'));
    expect(info?.reason).toBe('fileNotDownloadable');
    expect(info?.permanent).toBe(true);
  });

  test('classifies bare forbidden 403 as permanent', () => {
    const info = classifyDriveError(gaxiosShape('forbidden'));
    expect(info?.reason).toBe('forbidden');
  });
});

describe('classifyDriveError — transient errors', () => {
  test('returns null for rateLimitExceeded 429', () => {
    expect(
      classifyDriveError(gaxiosShape('rateLimitExceeded', 429))
    ).toBeNull();
  });

  test('returns null for userRateLimitExceeded 429', () => {
    expect(
      classifyDriveError(gaxiosShape('userRateLimitExceeded', 429))
    ).toBeNull();
  });

  test('returns null for a 503 internalError', () => {
    expect(classifyDriveError(gaxiosShape('internalError', 503))).toBeNull();
  });

  test('returns null for a plain network Error', () => {
    expect(classifyDriveError(new Error('network timeout'))).toBeNull();
  });

  test('returns null for undefined / non-object', () => {
    expect(classifyDriveError(undefined)).toBeNull();
    expect(classifyDriveError('boom')).toBeNull();
    expect(classifyDriveError(42)).toBeNull();
  });
});

describe('classifyDriveError — message fallback', () => {
  test('matches the flattened JSON body seen in the bug report', () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message:
          'The user has not granted the app 893319340876 read access to the file X.',
        errors: [
          {
            message:
              'The user has not granted the app 893319340876 read access to the file X.',
            domain: 'global',
            reason: 'appNotAuthorizedToFile',
            location: 'Authorization',
            locationType: 'header',
          },
        ],
      },
    });
    const err = new Error(body);
    const info = classifyDriveError(err);
    expect(info?.reason).toBe('appNotAuthorizedToFile');
    expect(info?.httpStatus).toBe(403);
  });

  test('matches fileNotDownloadable in the message when no structured shape', () => {
    const info = classifyDriveError(new Error('oops: fileNotDownloadable'));
    expect(info?.reason).toBe('fileNotDownloadable');
  });
});

describe('isPermanentErrorMessage', () => {
  test('true for messages with the marker prefix', () => {
    expect(
      isPermanentErrorMessage('[permanent:appNotAuthorizedToFile] boom')
    ).toBe(true);
  });

  test('false for raw error messages', () => {
    expect(isPermanentErrorMessage('boom')).toBe(false);
  });

  test('false for null', () => {
    expect(isPermanentErrorMessage(null)).toBe(false);
  });
});

describe('formatPermanentError', () => {
  test('prefixes with the marker and the reason', () => {
    const info = {
      permanent: true as const,
      reason: 'appNotAuthorizedToFile' as const,
      httpStatus: 403,
    };
    const formatted = formatPermanentError(info, 'oops');
    expect(formatted).toBe(
      `${PERMANENT_ERROR_PREFIX}appNotAuthorizedToFile] oops`
    );
    expect(isPermanentErrorMessage(formatted)).toBe(true);
  });

  test('truncates long messages and keeps only the first line', () => {
    const info = {
      permanent: true as const,
      reason: 'forbidden' as const,
      httpStatus: 403,
    };
    const long = `${'x'.repeat(500)}\nsecond line`;
    const formatted = formatPermanentError(info, long);
    expect(formatted.length).toBeLessThan(250);
    expect(formatted).not.toContain('second line');
    expect(formatted.endsWith('...')).toBe(true);
  });
});

describe('humanizePermanentReason', () => {
  test('returns a human-readable sentence for each permanent reason', () => {
    expect(humanizePermanentReason('appNotAuthorizedToFile')).toContain(
      'not authorized'
    );
    expect(humanizePermanentReason('forbidden')).toContain('forbidden');
    expect(humanizePermanentReason('fileNotDownloadable')).toContain(
      'not downloadable'
    );
  });
});
