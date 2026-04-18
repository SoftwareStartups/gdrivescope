import { ensureScope, SCOPE_READONLY } from '../../auth/scopes.js';
import { createDriveClient } from '../../drive/client.js';
import { downloadToFile } from '../../drive/download.js';
import { withStore } from '../../graph/store.js';
import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { getDbPath } from '../../utils/config.js';
import { CliError, toResponse } from '../../utils/errors.js';

export interface DownloadFlags {
  _positional?: string;
  output?: string;
  o?: string;
  format?: 'auto' | 'raw' | string;
}

export interface DownloadData {
  id: string;
  outputPath: string;
  bytes: number;
  mimeType: string;
}

export const HELP = `gdrivescope download — Download a file from Drive

Google Workspace docs are exported to Office formats unless --format raw is
passed.

Usage:
  gdrivescope download <ID> [-o PATH] [--format auto|raw]

Options:
  -o, --output <PATH>   Destination file or directory (default: cwd)
  --format <auto|raw>   auto = use export map (default), raw = binary bytes
  --json                Emit JSON envelope instead of human-readable output
`;

function resolveFormat(value: string | undefined): 'auto' | 'raw' {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'raw') return 'raw';
  throw new CliError(
    `invalid --format value: ${value} (expected auto|raw)`,
    'USAGE'
  );
}

export async function run(
  flags: DownloadFlags
): Promise<ApiResponse<DownloadData>> {
  if (!flags._positional) {
    return toResponse(
      new CliError('Usage: gdrivescope download <ID>', 'MISSING_ARG')
    );
  }
  const positional = flags._positional;
  try {
    await ensureScope(SCOPE_READONLY);
    const row = withStore(getDbPath(), (store) => store.getNode(positional));
    if (!row) {
      throw new CliError(
        `No node ${positional}. Run \`gdrivescope index\` first.`,
        'NODE_NOT_FOUND'
      );
    }
    const format = resolveFormat(flags.format);
    const destPath = flags.output ?? flags.o ?? process.cwd();
    const client = await createDriveClient();
    const result = await downloadToFile(
      client,
      { id: row.id, name: row.name, mimeType: row.mimeType },
      destPath,
      format
    );
    return success({ id: row.id, ...result });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: DownloadData): string {
  return `Downloaded ${data.outputPath} (${data.bytes} bytes, ${data.mimeType})`;
}
