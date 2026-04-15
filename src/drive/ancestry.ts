import type { drive_v3 } from '@googleapis/drive';
import type { ConfigRoot } from '../config/workspace.js';
import type { DriveNodeInput } from '../graph/model.js';

const ANCESTRY_FIELDS =
  'id,name,mimeType,parents,size,modifiedTime,createdTime,webViewLink';
const MAX_ANCESTOR_HOPS = 50;
const MY_DRIVE_SENTINEL = 'root';

export interface ResolvedAncestry {
  /** Resolved root folder id (never the `"root"` sentinel). */
  rootId: string;
  /** Display label for the root — config override, otherwise Drive's folder name. */
  rootLabel: string;
  /**
   * Ancestor chain from the root down to (but not including) the scope folder.
   * Each entry is ready to be passed to `store.upsertNode` — the root gets
   * `parentId: null`, all other ancestors carry their real parent.
   *
   * Empty when the scope is already the configured root (no ancestry to stitch).
   */
  chain: DriveNodeInput[];
  /**
   * The scope folder itself, stamped with the resolved `rootId`. Traversal
   * uses this as the BFS seed.
   */
  scope: DriveNodeInput;
  /** True when no configured root could be matched and the scope is acting as its own root. */
  usedFallback: boolean;
}

function fileToNode(
  file: drive_v3.Schema$File,
  parentId: string | null,
  rootId: string,
  labelOverride?: string
): DriveNodeInput {
  return {
    id: file.id ?? '',
    parentId,
    name: labelOverride ?? file.name ?? '(untitled)',
    mimeType: file.mimeType ?? 'application/vnd.google-apps.folder',
    size: file.size != null ? Number(file.size) : undefined,
    modifiedTime: file.modifiedTime ?? undefined,
    createdTime: file.createdTime ?? undefined,
    webViewLink: file.webViewLink ?? undefined,
    rootId,
    metadata: file as unknown as Record<string, unknown>,
  };
}

async function fetchFolder(
  client: drive_v3.Drive,
  id: string
): Promise<drive_v3.Schema$File> {
  const resp = await client.files.get({
    fileId: id,
    fields: ANCESTRY_FIELDS,
    supportsAllDrives: true,
  });
  return resp.data;
}

/**
 * Walk from `scopeId` upward via `parents[0]` until we either hit a
 * configured root or run out of parents. Returns the full chain (root first),
 * the scope file last. Cycles and runaway chains are guarded.
 */
export async function resolveAncestry(
  client: drive_v3.Drive,
  scopeId: string,
  configuredRoots: ConfigRoot[]
): Promise<ResolvedAncestry> {
  // Expand the `"root"` sentinel — if any configured root uses it, resolve it
  // once so we can match it against ancestor ids further up the chain.
  const configMap = new Map<string, ConfigRoot>();
  let myDriveId: string | null = null;
  for (const r of configuredRoots) {
    if (r.id === MY_DRIVE_SENTINEL) {
      if (myDriveId === null) {
        const rootFile = await fetchFolder(client, MY_DRIVE_SENTINEL);
        myDriveId = rootFile.id ?? MY_DRIVE_SENTINEL;
      }
      configMap.set(myDriveId, r);
    } else {
      configMap.set(r.id, r);
    }
  }

  const scopeFile = await fetchFolder(
    client,
    scopeId === MY_DRIVE_SENTINEL ? MY_DRIVE_SENTINEL : scopeId
  );
  const scopeRealId = scopeFile.id ?? scopeId;

  // No configured roots at all → the scope must act as its own root.
  // Skip the parent walk entirely, otherwise we'd burn Drive API calls we
  // know we can't match.
  if (configMap.size === 0) {
    return {
      rootId: scopeRealId,
      rootLabel: scopeFile.name ?? scopeRealId,
      chain: [],
      scope: fileToNode(scopeFile, null, scopeRealId),
      usedFallback: true,
    };
  }

  // If the scope itself is a configured root, short-circuit: no ancestry,
  // scope becomes its own root.
  const scopeRoot = configMap.get(scopeRealId);
  if (scopeRoot) {
    return {
      rootId: scopeRealId,
      rootLabel: scopeRoot.label ?? scopeFile.name ?? scopeRealId,
      chain: [],
      scope: fileToNode(
        scopeFile,
        null,
        scopeRealId,
        scopeRoot.label ?? undefined
      ),
      usedFallback: false,
    };
  }

  // Walk up from scope's parent, collecting folders until we hit a configured root.
  const ascending: drive_v3.Schema$File[] = [];
  const seen = new Set<string>([scopeRealId]);
  let cursor = scopeFile.parents?.[0] ?? null;
  let matchedRootId: string | null = null;
  let hops = 0;

  while (cursor && hops < MAX_ANCESTOR_HOPS) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const folder = await fetchFolder(client, cursor);
    ascending.push(folder);
    const folderId = folder.id ?? cursor;
    if (configMap.has(folderId)) {
      matchedRootId = folderId;
      break;
    }
    cursor = folder.parents?.[0] ?? null;
    hops += 1;
  }

  if (matchedRootId === null) {
    // Fallback: no configured root on the chain. Scope becomes its own root,
    // no ancestry stitched, caller emits a warning.
    return {
      rootId: scopeRealId,
      rootLabel: scopeFile.name ?? scopeRealId,
      chain: [],
      scope: fileToNode(scopeFile, null, scopeRealId),
      usedFallback: true,
    };
  }

  const rootConfig = configMap.get(matchedRootId);
  const rootLabel =
    rootConfig?.label ?? ascending[ascending.length - 1]?.name ?? matchedRootId;

  // Build chain in root→scope.parent order. `ascending` is scope.parent → root.
  const chain: DriveNodeInput[] = [];
  for (let i = ascending.length - 1; i >= 0; i -= 1) {
    const folder = ascending[i];
    const id = folder.id ?? '';
    const isRoot = id === matchedRootId;
    const parentId = isRoot ? null : (folder.parents?.[0] ?? null);
    chain.push(
      fileToNode(
        folder,
        parentId,
        matchedRootId,
        isRoot ? rootLabel : undefined
      )
    );
  }

  // The scope's parent is the last element of `ascending[0]` (its direct parent).
  const scopeParentId = scopeFile.parents?.[0] ?? null;
  return {
    rootId: matchedRootId,
    rootLabel,
    chain,
    scope: fileToNode(scopeFile, scopeParentId, matchedRootId),
    usedFallback: false,
  };
}
