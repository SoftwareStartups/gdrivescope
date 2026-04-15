import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { drive_v3 } from '@googleapis/drive';
import {
  downloadToFile,
  EXPORT_MIME_MAP,
  resolveExport,
} from '../../src/drive/download.js';
import { CliError } from '../../src/utils/errors.js';

interface RecordedCall {
  kind: 'get' | 'export';
  fileId: string;
  mimeType?: string;
}

function makeFakeClient(payloads: Record<string, string>): {
  client: drive_v3.Drive;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const files = {
    get(params: { fileId: string; alt?: string }) {
      calls.push({ kind: 'get', fileId: params.fileId });
      return Promise.resolve({
        data: Readable.from([payloads[`get:${params.fileId}`] ?? '']),
      });
    },
    export(params: { fileId: string; mimeType: string }) {
      calls.push({
        kind: 'export',
        fileId: params.fileId,
        mimeType: params.mimeType,
      });
      return Promise.resolve({
        data: Readable.from([
          payloads[`export:${params.fileId}:${params.mimeType}`] ?? '',
        ]),
      });
    },
  };
  return { client: { files } as unknown as drive_v3.Drive, calls };
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'gdrivescope-download-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('downloadToFile', () => {
  test('streams raw bytes for a non-workspace file', async () => {
    const { client, calls } = makeFakeClient({ 'get:pdf1': 'hello world' });
    const result = await downloadToFile(
      client,
      { id: 'pdf1', name: 'report.pdf', mimeType: 'application/pdf' },
      workDir
    );
    expect(result.bytes).toBe('hello world'.length);
    expect(result.mimeType).toBe('application/pdf');
    expect(result.outputPath).toBe(join(workDir, 'report.pdf'));
    expect(readFileSync(result.outputPath, 'utf8')).toBe('hello world');
    expect(calls[0]?.kind).toBe('get');
  });

  test('exports a Google Doc to .docx', async () => {
    const targetMime =
      EXPORT_MIME_MAP['application/vnd.google-apps.document']?.targetMime ?? '';
    const { client, calls } = makeFakeClient({
      [`export:doc1:${targetMime}`]: 'docx-body',
    });
    const result = await downloadToFile(
      client,
      {
        id: 'doc1',
        name: 'notes',
        mimeType: 'application/vnd.google-apps.document',
      },
      workDir
    );
    expect(result.outputPath).toBe(join(workDir, 'notes.docx'));
    expect(result.mimeType).toBe(targetMime);
    expect(readFileSync(result.outputPath, 'utf8')).toBe('docx-body');
    expect(calls[0]).toEqual({
      kind: 'export',
      fileId: 'doc1',
      mimeType: targetMime,
    });
  });

  test('does not double-append extension when the name already has one', async () => {
    const targetMime =
      EXPORT_MIME_MAP['application/vnd.google-apps.document']?.targetMime ?? '';
    const { client } = makeFakeClient({
      [`export:doc2:${targetMime}`]: 'body',
    });
    const result = await downloadToFile(
      client,
      {
        id: 'doc2',
        name: 'notes.docx',
        mimeType: 'application/vnd.google-apps.document',
      },
      workDir
    );
    expect(result.outputPath).toBe(join(workDir, 'notes.docx'));
  });

  test('throws UNSUPPORTED_MIME for Forms in auto mode', async () => {
    const { client } = makeFakeClient({});
    try {
      await downloadToFile(
        client,
        {
          id: 'f1',
          name: 'survey',
          mimeType: 'application/vnd.google-apps.form',
        },
        workDir
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('UNSUPPORTED_MIME');
    }
  });

  test('format=raw fetches bytes even for a Google Doc', async () => {
    const { client, calls } = makeFakeClient({ 'get:doc3': 'raw-bytes' });
    const result = await downloadToFile(
      client,
      {
        id: 'doc3',
        name: 'doc3',
        mimeType: 'application/vnd.google-apps.document',
      },
      workDir,
      'raw'
    );
    expect(calls[0]?.kind).toBe('get');
    expect(result.mimeType).toBe('application/vnd.google-apps.document');
    expect(readFileSync(result.outputPath, 'utf8')).toBe('raw-bytes');
  });

  test('resolveExport returns null for non-workspace mimes', () => {
    expect(resolveExport('application/pdf')).toBeNull();
    expect(
      resolveExport('application/vnd.google-apps.spreadsheet')
    ).not.toBeNull();
  });

  test('writes to an explicit file path when destPath is not a directory', async () => {
    const { client } = makeFakeClient({ 'get:pdf2': 'bytes' });
    const dest = join(workDir, 'nested', 'out.pdf');
    const result = await downloadToFile(
      client,
      { id: 'pdf2', name: 'ignored.pdf', mimeType: 'application/pdf' },
      dest
    );
    expect(result.outputPath).toBe(dest);
    expect(readFileSync(dest, 'utf8')).toBe('bytes');
  });
});
