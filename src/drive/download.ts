import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { drive_v3 } from '@googleapis/drive';
import { CliError } from '../utils/errors.js';

export interface ExportTarget {
  targetMime: string;
  extension: string;
}

export const EXPORT_MIME_MAP: Record<string, ExportTarget> = {
  'application/vnd.google-apps.document': {
    targetMime:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    targetMime:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    targetMime:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
  'application/vnd.google-apps.drawing': {
    targetMime: 'application/pdf',
    extension: '.pdf',
  },
};

// Text-first export profile for the index pipeline. Google exports Docs/Slides
// to plain text and Sheets to CSV server-side, skipping Kreuzberg entirely and
// dropping bandwidth ~10× vs the Office-byte profile. Drawings still export as
// PDF because Google has no text export path for them.
export const TEXT_EXPORT_MIME_MAP: Record<string, ExportTarget> = {
  'application/vnd.google-apps.document': {
    targetMime: 'text/plain',
    extension: '.txt',
  },
  'application/vnd.google-apps.spreadsheet': {
    targetMime: 'text/csv',
    extension: '.csv',
  },
  'application/vnd.google-apps.presentation': {
    targetMime: 'text/plain',
    extension: '.txt',
  },
  'application/vnd.google-apps.drawing': {
    targetMime: 'application/pdf',
    extension: '.pdf',
  },
};

export function resolveExport(
  mime: string,
  map: Record<string, ExportTarget> = EXPORT_MIME_MAP
): ExportTarget | null {
  return map[mime] ?? null;
}

export interface DownloadTargetFile {
  id: string;
  name: string;
  mimeType: string;
}

export interface DownloadResult {
  outputPath: string;
  bytes: number;
  mimeType: string;
}

function sanitizeName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping path separators and NUL from filenames
  return basename(name).replace(/[\\/\x00]/g, '_');
}

export async function downloadToFile(
  client: drive_v3.Drive,
  file: DownloadTargetFile,
  destPath: string,
  format: 'auto' | 'raw' = 'auto',
  exportMap: Record<string, ExportTarget> = EXPORT_MIME_MAP
): Promise<DownloadResult> {
  const exportTarget =
    format === 'auto' ? (exportMap[file.mimeType] ?? null) : null;

  if (
    !exportTarget &&
    format === 'auto' &&
    file.mimeType.startsWith('application/vnd.google-apps.')
  ) {
    throw new CliError(
      `No export path for ${file.mimeType}. Use --format raw or download manually from Drive.`,
      'UNSUPPORTED_MIME'
    );
  }

  const extension = exportTarget ? exportTarget.extension : extname(file.name);
  const mimeForFetch = exportTarget ? exportTarget.targetMime : file.mimeType;

  let outputPath = destPath;
  if (existsSync(outputPath) && statSync(outputPath).isDirectory()) {
    const safeName = sanitizeName(file.name);
    const withExt =
      extension && !safeName.toLowerCase().endsWith(extension.toLowerCase())
        ? `${safeName}${extension}`
        : safeName;
    outputPath = join(outputPath, withExt);
  }
  mkdirSync(dirname(outputPath), { recursive: true });

  const response = exportTarget
    ? await client.files.export(
        { fileId: file.id, mimeType: exportTarget.targetMime },
        { responseType: 'stream' }
      )
    : await client.files.get(
        { fileId: file.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );

  const writeStream = createWriteStream(outputPath);
  await pipeline(response.data as NodeJS.ReadableStream, writeStream);
  const bytes = statSync(outputPath).size;
  return { outputPath, bytes, mimeType: mimeForFetch };
}
