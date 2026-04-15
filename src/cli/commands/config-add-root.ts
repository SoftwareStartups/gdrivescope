import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  upsertRoot,
} from '../../config/workspace.js';
import { createDriveClient } from '../../drive/client.js';
import type { ApiResponse } from '../../models/api-response.js';
import { fail, success } from '../../models/api-response.js';
import { toResponse } from '../../utils/errors.js';

export interface ConfigAddRootFlags {
  _positional?: string;
  label?: string;
}

export interface ConfigAddRootData {
  id: string;
  resolvedId: string;
  label: string;
  configPath: string;
}

export const HELP = `gdrivescope config add-root — Persist a Drive folder as a root

Validates that the folder exists (via files.get) and appends it to
\`config.toml\`. The folder id is the stable anchor point for future
\`index --scope …\` runs, so their ancestor chains converge.

Usage:
  gdrivescope config add-root <FOLDER_ID> [--label <NAME>] [--json]

Arguments:
  FOLDER_ID              Drive folder id (or \`root\` for My Drive)

Options:
  --label <NAME>         Display label override for this root
`;

export async function run(
  flags: ConfigAddRootFlags
): Promise<ApiResponse<ConfigAddRootData>> {
  const raw = flags._positional;
  if (!raw) {
    return fail(
      'missing FOLDER_ID argument — usage: gdrivescope config add-root <FOLDER_ID>',
      'USAGE'
    );
  }
  try {
    const client = await createDriveClient();
    const response = await client.files.get({
      fileId: raw,
      fields: 'id,name,mimeType',
      supportsAllDrives: true,
    });
    const file = response.data;
    const resolvedId = file.id ?? raw;
    const label = flags.label ?? file.name ?? resolvedId;

    const cfg = await loadWorkspaceConfig();
    const updated = upsertRoot(cfg, { id: resolvedId, label });
    const path = await saveWorkspaceConfig(updated);

    return success({
      id: raw,
      resolvedId,
      label,
      configPath: path,
    });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: ConfigAddRootData): string {
  return [
    `Added root ${data.label} (${data.resolvedId})`,
    `  config: ${data.configPath}`,
  ].join('\n');
}
