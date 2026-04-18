import { SKIPPED_MIMES } from '../extract/mime-filter.js';

export type NodeType = 'folder' | 'file' | 'shortcut' | 'other';

export const NODE_TYPES: readonly NodeType[] = [
  'folder',
  'file',
  'shortcut',
  'other',
];

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export function classifyNodeType(mime: string): NodeType {
  if (mime === FOLDER_MIME) return 'folder';
  if (mime === SHORTCUT_MIME) return 'shortcut';
  if (SKIPPED_MIMES.has(mime)) return 'other';
  if (mime.startsWith('image/')) return 'other';
  if (mime.startsWith('audio/')) return 'other';
  if (mime.startsWith('video/')) return 'other';
  return 'file';
}

export function isNodeType(value: string): value is NodeType {
  return (NODE_TYPES as readonly string[]).includes(value);
}
