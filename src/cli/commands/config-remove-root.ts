import {
  findRoot,
  loadWorkspaceConfig,
  removeRoot,
  saveWorkspaceConfig,
} from '../../config/workspace.js';
import type { ApiResponse } from '../../models/api-response.js';
import { fail, success } from '../../models/api-response.js';
import { toResponse } from '../../utils/errors.js';

export interface ConfigRemoveRootFlags {
  _positional?: string;
}

export interface ConfigRemoveRootData {
  id: string;
  removed: boolean;
  configPath: string;
}

export const HELP = `gdrivescope config remove-root — Remove a configured root

Deletes a root entry from \`config.toml\`. Nodes already indexed under the
removed root stay in \`drive.db\` — delete the db manually if you want a
clean slate.

Usage:
  gdrivescope config remove-root <FOLDER_ID> [--json]
`;

export async function run(
  flags: ConfigRemoveRootFlags
): Promise<ApiResponse<ConfigRemoveRootData>> {
  const raw = flags._positional;
  if (!raw) {
    return fail(
      'missing FOLDER_ID argument — usage: gdrivescope config remove-root <FOLDER_ID>',
      'USAGE'
    );
  }
  try {
    const cfg = await loadWorkspaceConfig();
    const existing = findRoot(cfg, raw);
    if (!existing) {
      return fail(`root ${raw} is not configured`, 'NOT_FOUND');
    }
    const updated = removeRoot(cfg, raw);
    const path = await saveWorkspaceConfig(updated);
    return success({ id: raw, removed: true, configPath: path });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: ConfigRemoveRootData): string {
  return `Removed root ${data.id} from ${data.configPath}`;
}
