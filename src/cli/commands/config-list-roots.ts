import { loadWorkspaceConfig } from '../../config/workspace.js';
import { withStoreAsync } from '../../graph/store.js';
import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { getDbPath } from '../../utils/config.js';
import { toResponse } from '../../utils/errors.js';

export type ConfigListRootsFlags = Record<string, never>;

export interface RootEntry {
  id: string;
  label: string | null;
  indexedNodes: number;
}

export interface ConfigListRootsData {
  roots: RootEntry[];
}

export const HELP = `gdrivescope config list-roots — List configured root folders

Shows each root configured in \`config.toml\` along with the number of nodes
currently indexed under it in \`drive.db\`. Also surfaces any roots that
appear in the database but are not (yet) present in the config.

Usage:
  gdrivescope config list-roots [--json]
`;

export async function run(
  _flags: ConfigListRootsFlags
): Promise<ApiResponse<ConfigListRootsData>> {
  try {
    return await withStoreAsync(getDbPath(), async (store) => {
      const cfg = await loadWorkspaceConfig();
      const summaries = store.listRoots();
      const countByRoot = new Map<string | null, number>();
      for (const s of summaries) countByRoot.set(s.rootId, s.count);

      const seen = new Set<string>();
      const roots: RootEntry[] = [];
      for (const r of cfg.roots) {
        seen.add(r.id);
        roots.push({
          id: r.id,
          label: r.label ?? null,
          indexedNodes: countByRoot.get(r.id) ?? 0,
        });
      }
      for (const s of summaries) {
        if (s.rootId === null || seen.has(s.rootId)) continue;
        roots.push({ id: s.rootId, label: null, indexedNodes: s.count });
      }
      return success({ roots });
    });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: ConfigListRootsData): string {
  if (data.roots.length === 0) {
    return 'No roots configured. Run: gdrivescope config add-root <FOLDER_ID>';
  }
  const lines = ['roots:'];
  for (const r of data.roots) {
    const label = r.label ?? '(unlabeled)';
    lines.push(`  - ${label} (${r.id}) — ${r.indexedNodes} indexed node(s)`);
  }
  return lines.join('\n');
}
