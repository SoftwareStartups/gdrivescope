export const SKIPPED_MIMES: ReadonlySet<string> = new Set([
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.map',
  'application/vnd.google-apps.jam',
  'application/vnd.google-apps.shortcut',
]);

export function shouldExtract(mime: string): boolean {
  if (SKIPPED_MIMES.has(mime)) return false;
  if (mime.startsWith('image/')) return false;
  if (mime.startsWith('audio/')) return false;
  if (mime.startsWith('video/')) return false;
  return true;
}
