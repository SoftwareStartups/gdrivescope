import type { drive_v3 } from '@googleapis/drive';
import type { DriveNodeInput } from '../graph/model.js';
import { createSemaphore } from '../pipeline/concurrency.js';

export interface TraverseOptions {
  /**
   * BFS starting folder id. For ancestry-aware runs, pass the scope folder id
   * — the ancestor chain should already be emitted by the caller via
   * `resolveAncestry`.
   */
  rootId: string;
  /**
   * Anchor root id stamped onto every emitted node. When omitted, falls back
   * to `rootId` (scope acts as its own root — legacy behaviour).
   */
  anchorRootId?: string;
  /**
   * Optional pre-resolved scope node. When provided, traversal skips the
   * `files.get` seed call and uses this node as the BFS entry (the caller is
   * expected to have emitted it and any ancestors already).
   */
  scopeNode?: DriveNodeInput;
  onNode: (node: DriveNodeInput) => void | Promise<void>;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface TraverseResult {
  visited: number;
  folders: number;
  files: number;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const LIST_FIELDS =
  'nextPageToken, files(id,name,mimeType,parents,size,modifiedTime,createdTime,webViewLink,shortcutDetails)';
const ROOT_FIELDS =
  'id,name,mimeType,parents,size,modifiedTime,createdTime,webViewLink';
const SHORTCUT_TARGET_FIELDS =
  'id,name,mimeType,size,modifiedTime,createdTime,webViewLink';

export const CONCURRENCY_DEFAULT = 4;
export const CONCURRENCY_MAX = 15;

function fileToNodeInput(
  file: drive_v3.Schema$File,
  parentId: string | null,
  rootId: string | null
): DriveNodeInput {
  return {
    id: file.id ?? '',
    parentId,
    name: file.name ?? '(untitled)',
    mimeType: file.mimeType ?? 'application/octet-stream',
    size: file.size != null ? Number(file.size) : undefined,
    modifiedTime: file.modifiedTime ?? undefined,
    createdTime: file.createdTime ?? undefined,
    webViewLink: file.webViewLink ?? undefined,
    rootId,
    metadata: file as unknown as Record<string, unknown>,
  };
}

function clampConcurrency(n: number | undefined): number {
  const raw = n ?? CONCURRENCY_DEFAULT;
  return Math.min(Math.max(raw, 1), CONCURRENCY_MAX);
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('traversal aborted');
  }
}

async function resolveShortcut(
  client: drive_v3.Drive,
  shortcut: drive_v3.Schema$File
): Promise<drive_v3.Schema$File> {
  const targetId = shortcut.shortcutDetails?.targetId;
  if (!targetId) return shortcut;
  const target = await client.files.get({
    fileId: targetId,
    fields: SHORTCUT_TARGET_FIELDS,
    supportsAllDrives: true,
  });
  const data = target.data;
  return {
    id: shortcut.id,
    parents: shortcut.parents,
    name: data.name ?? shortcut.name,
    mimeType: data.mimeType ?? shortcut.mimeType,
    size: data.size ?? shortcut.size,
    modifiedTime: data.modifiedTime ?? shortcut.modifiedTime,
    createdTime: data.createdTime ?? shortcut.createdTime,
    webViewLink: data.webViewLink ?? shortcut.webViewLink,
    shortcutDetails: shortcut.shortcutDetails,
  };
}

async function listChildren(
  client: drive_v3.Drive,
  folderId: string,
  signal: AbortSignal | undefined
): Promise<drive_v3.Schema$File[]> {
  const results: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    checkAbort(signal);
    const page = await client.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: LIST_FIELDS,
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const file of page.data.files ?? []) {
      results.push(file);
    }
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);
  return results;
}

export async function traverseDriveFolder(
  client: drive_v3.Drive,
  opts: TraverseOptions
): Promise<TraverseResult> {
  const max = clampConcurrency(opts.concurrency);
  const sem = createSemaphore(max);
  const seenFolders = new Set<string>();
  const queue: string[] = [];

  let visited = 0;
  let folders = 0;
  let files = 0;

  let bfsStartId: string;

  if (opts.scopeNode) {
    // Caller already emitted the scope node (and any ancestors). Just seed
    // the queue from it without fetching or re-emitting.
    bfsStartId = opts.scopeNode.id;
  } else {
    // Legacy path: seed by fetching the scope folder metadata and emitting
    // it as its own root.
    const anchorRootId = opts.anchorRootId ?? null;
    const rootResponse = await client.files.get({
      fileId: opts.rootId,
      fields: ROOT_FIELDS,
      supportsAllDrives: true,
    });
    const rootFile = rootResponse.data;
    const resolvedRootId = rootFile.id ?? opts.rootId;
    await opts.onNode(
      fileToNodeInput(rootFile, null, anchorRootId ?? resolvedRootId)
    );
    visited += 1;
    folders += 1;
    bfsStartId = resolvedRootId;
  }

  const anchor = opts.anchorRootId ?? bfsStartId;
  seenFolders.add(bfsStartId);
  queue.push(bfsStartId);

  const visitFolder = async (folderId: string): Promise<void> => {
    const release = await sem.acquire();
    try {
      const entries = await listChildren(client, folderId, opts.signal);
      for (const file of entries) {
        let node = file;
        if (file.mimeType === SHORTCUT_MIME) {
          node = await resolveShortcut(client, file);
        }
        await opts.onNode(fileToNodeInput(node, folderId, anchor));
        visited += 1;
        if (node.mimeType === FOLDER_MIME) {
          folders += 1;
          // For folder shortcuts the synthesized node keeps the shortcut's own
          // id, but Drive's parent/child graph only links children to the
          // target id. Queue the target id so BFS actually descends.
          const childId =
            file.mimeType === SHORTCUT_MIME
              ? (file.shortcutDetails?.targetId ?? null)
              : node.id;
          if (childId && !seenFolders.has(childId)) {
            seenFolders.add(childId);
            queue.push(childId);
          }
        } else {
          files += 1;
        }
      }
    } finally {
      release();
    }
  };

  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length);
    await Promise.all(batch.map(visitFolder));
  }

  return { visited, folders, files };
}
