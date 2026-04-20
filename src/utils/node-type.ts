import { CliError } from './errors.js';

export type NodeType = 'folder' | 'file' | 'shortcut' | 'other';

export const NODE_TYPES: readonly NodeType[] = [
  'folder',
  'file',
  'shortcut',
  'other',
];

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

// Google-specific artifacts that aren't regular "files" in the user's mental
// model. Kept independent of the extraction-skip set so that files Drive
// returns with unknown MIME (e.g. application/octet-stream) still classify
// as "file" for list/search filtering, even though extraction skips them.
const OTHER_MIMES: ReadonlySet<string> = new Set([
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.map',
  'application/vnd.google-apps.jam',
]);

export function classifyNodeType(mime: string): NodeType {
  if (mime === FOLDER_MIME) return 'folder';
  if (mime === SHORTCUT_MIME) return 'shortcut';
  if (OTHER_MIMES.has(mime)) return 'other';
  if (mime.startsWith('image/')) return 'other';
  if (mime.startsWith('audio/')) return 'other';
  if (mime.startsWith('video/')) return 'other';
  return 'file';
}

export function isNodeType(value: string): value is NodeType {
  return (NODE_TYPES as readonly string[]).includes(value);
}

export function parseTypeFilter(value: string | undefined): NodeType | null {
  if (value === undefined) return null;
  if (!isNodeType(value)) {
    throw new CliError(
      `invalid --type value: ${value} (expected ${NODE_TYPES.join('|')})`,
      'USAGE'
    );
  }
  return value;
}
