import { hydrateGraph } from '../../graph/hydrate.js';
import type { Node } from '../../graph/model.js';
import { nodePath } from '../../graph/paths.js';
import { withStoreAsync } from '../../graph/store.js';
import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { getDbPath } from '../../utils/config.js';
import { CliError, toResponse } from '../../utils/errors.js';

export interface ShowFlags {
  _positional?: string;
}

export type ShowNode = Omit<Node, 'metadataJson' | 'keyTopics'> & {
  metadata: unknown;
  keyTopics: string[] | null;
};

export interface ShowData {
  node: ShowNode;
  path: string;
}

export const HELP = `gdrivescope show — Show a single node from the indexed graph

Usage:
  gdrivescope show <ID> [--json]
`;

function parseKeyTopics(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function parseMetadata(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toShowNode(row: Node): ShowNode {
  const { metadataJson, keyTopics, ...rest } = row;
  return {
    ...rest,
    metadata: parseMetadata(metadataJson),
    keyTopics: parseKeyTopics(keyTopics),
  };
}

export async function run(flags: ShowFlags): Promise<ApiResponse<ShowData>> {
  if (!flags._positional) {
    return toResponse(
      new CliError('Usage: gdrivescope show <ID>', 'MISSING_ARG')
    );
  }
  const positional = flags._positional;
  try {
    return await withStoreAsync(getDbPath(), async (store) => {
      const row = store.getNode(positional);
      if (!row) {
        throw new CliError(`No node ${positional} in index.`, 'NODE_NOT_FOUND');
      }
      const graph = hydrateGraph(store);
      return success({ node: toShowNode(row), path: nodePath(graph, row.id) });
    });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: ShowData): string {
  const lines = [
    data.node.name,
    `  id:      ${data.node.id}`,
    `  mime:    ${data.node.mimeType}`,
    `  path:    ${data.path}`,
  ];
  if (data.node.size !== undefined && data.node.size !== null) {
    lines.push(`  size:    ${data.node.size}`);
  }
  if (data.node.modifiedTime) {
    lines.push(`  mtime:   ${data.node.modifiedTime}`);
  }
  if (data.node.webViewLink) {
    lines.push(`  link:    ${data.node.webViewLink}`);
  }
  if (data.node.classification) {
    lines.push(`  class:   ${data.node.classification}`);
  }
  return lines.join('\n');
}
