import {
  type ConfigRoot,
  loadWorkspaceConfig,
} from '../../config/workspace.js';
import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { configPath } from '../../utils/config.js';
import { toResponse } from '../../utils/errors.js';

export type ConfigShowFlags = Record<string, never>;

export interface ConfigShowData {
  path: string;
  roots: ConfigRoot[];
  folders: Record<string, string>;
}

export const HELP = `gdrivescope config show — Print the workspace config

Reads \`~/.config/gdrivescope/config.toml\` and prints the configured roots
and folder aliases. Missing config prints an empty layout (not an error).

Usage:
  gdrivescope config show [--json]
`;

export async function run(
  _flags: ConfigShowFlags
): Promise<ApiResponse<ConfigShowData>> {
  try {
    const path = Bun.env.GDRIVESCOPE_CONFIG ?? configPath();
    const cfg = await loadWorkspaceConfig();
    return success({ path, roots: cfg.roots, folders: cfg.folders });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: ConfigShowData): string {
  const lines = [`config: ${data.path}`, ''];
  if (data.roots.length === 0) {
    lines.push('roots: (none)');
  } else {
    lines.push('roots:');
    for (const r of data.roots) {
      lines.push(`  - ${r.label ?? r.id} (${r.id})`);
    }
  }
  lines.push('');
  const folderEntries = Object.entries(data.folders);
  if (folderEntries.length === 0) {
    lines.push('folders: (none)');
  } else {
    lines.push('folders:');
    for (const [name, id] of folderEntries) {
      lines.push(`  ${name} = ${id}`);
    }
  }
  return lines.join('\n');
}
