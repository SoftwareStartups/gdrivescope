export const SKIPPED_MIMES: ReadonlySet<string> = new Set([
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.map',
  'application/vnd.google-apps.jam',
  'application/vnd.google-apps.shortcut',
  // Drive's fallback when it can't classify a file. Kreuzberg needs a
  // concrete MIME type to pick a parser; octet-stream always errors with
  // "Could not determine MIME type from bytes".
  'application/octet-stream',
]);

export function shouldExtract(mime: string): boolean {
  if (SKIPPED_MIMES.has(mime)) return false;
  if (mime.startsWith('image/')) return false;
  if (mime.startsWith('audio/')) return false;
  if (mime.startsWith('video/')) return false;
  return true;
}
