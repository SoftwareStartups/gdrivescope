import { describe, expect, test } from 'bun:test';
import type { drive_v3 } from '@googleapis/drive';
import { resolveAncestry } from '../../src/drive/ancestry.js';

const FOLDER = 'application/vnd.google-apps.folder';

interface FakeFolder {
  id: string;
  name: string;
  parents?: string[];
}

function makeFakeClient(
  folders: Record<string, FakeFolder>,
  opts?: { myDriveId?: string }
): drive_v3.Drive {
  const myDriveId = opts?.myDriveId ?? 'my-drive';
  const files = {
    async get(params: { fileId: string; fields?: string }) {
      const id = params.fileId === 'root' ? myDriveId : params.fileId;
      const folder = folders[id];
      if (!folder) {
        throw new Error(`fake client: no folder ${id}`);
      }
      return {
        data: {
          id: folder.id,
          name: folder.name,
          mimeType: FOLDER,
          parents: folder.parents,
        } satisfies drive_v3.Schema$File,
      };
    },
  };
  return { files } as unknown as drive_v3.Drive;
}

describe('resolveAncestry', () => {
  test('scope equals configured root → empty chain, no fallback', async () => {
    const client = makeFakeClient({
      'root-id': { id: 'root-id', name: 'Company' },
    });
    const result = await resolveAncestry(client, 'root-id', [
      { id: 'root-id', label: 'Company Drive' },
    ]);
    expect(result.rootId).toBe('root-id');
    expect(result.rootLabel).toBe('Company Drive');
    expect(result.chain).toEqual([]);
    expect(result.scope.id).toBe('root-id');
    expect(result.scope.parentId).toBeNull();
    expect(result.scope.rootId).toBe('root-id');
    expect(result.scope.name).toBe('Company Drive');
    expect(result.usedFallback).toBe(false);
  });

  test('scope two levels under configured root → chain stitches path', async () => {
    const client = makeFakeClient({
      'root-id': { id: 'root-id', name: 'Company' },
      projects: { id: 'projects', name: 'Projects', parents: ['root-id'] },
      acme: { id: 'acme', name: 'Acme', parents: ['projects'] },
    });
    const result = await resolveAncestry(client, 'acme', [
      { id: 'root-id', label: 'Company Drive' },
    ]);
    expect(result.rootId).toBe('root-id');
    expect(result.rootLabel).toBe('Company Drive');
    expect(result.chain).toHaveLength(2);
    // chain[0] = root, chain[1] = Projects
    expect(result.chain[0]?.id).toBe('root-id');
    expect(result.chain[0]?.parentId).toBeNull();
    expect(result.chain[0]?.rootId).toBe('root-id');
    expect(result.chain[0]?.name).toBe('Company Drive');
    expect(result.chain[1]?.id).toBe('projects');
    expect(result.chain[1]?.parentId).toBe('root-id');
    expect(result.chain[1]?.rootId).toBe('root-id');
    // scope hangs under Projects with the same rootId stamped.
    expect(result.scope.id).toBe('acme');
    expect(result.scope.parentId).toBe('projects');
    expect(result.scope.rootId).toBe('root-id');
    expect(result.usedFallback).toBe(false);
  });

  test('`root` sentinel in config expands to My Drive folder id', async () => {
    const client = makeFakeClient(
      {
        'my-drive': { id: 'my-drive', name: 'My Drive' },
        personal: { id: 'personal', name: 'Personal', parents: ['my-drive'] },
        notes: { id: 'notes', name: 'Notes', parents: ['personal'] },
      },
      { myDriveId: 'my-drive' }
    );
    const result = await resolveAncestry(client, 'notes', [
      { id: 'root', label: 'Home' },
    ]);
    expect(result.rootId).toBe('my-drive');
    expect(result.rootLabel).toBe('Home');
    expect(result.chain.map((n) => n.id)).toEqual(['my-drive', 'personal']);
    expect(result.chain[0]?.name).toBe('Home');
    expect(result.usedFallback).toBe(false);
  });

  test('no configured root on chain → usedFallback, scope becomes its own root', async () => {
    const client = makeFakeClient({
      orphan: { id: 'orphan', name: 'Orphan' },
    });
    const result = await resolveAncestry(client, 'orphan', [
      { id: 'elsewhere', label: 'Elsewhere' },
    ]);
    expect(result.usedFallback).toBe(true);
    expect(result.rootId).toBe('orphan');
    expect(result.rootLabel).toBe('Orphan');
    expect(result.chain).toEqual([]);
    expect(result.scope.parentId).toBeNull();
    expect(result.scope.rootId).toBe('orphan');
  });

  test('no configured roots at all → fallback without walking parents', async () => {
    const client = makeFakeClient({
      'top-folder': { id: 'top-folder', name: 'Top', parents: ['something'] },
    });
    const result = await resolveAncestry(client, 'top-folder', []);
    expect(result.usedFallback).toBe(true);
    expect(result.rootId).toBe('top-folder');
    expect(result.chain).toEqual([]);
  });

  test('picks first matching root when multiple configured', async () => {
    const client = makeFakeClient({
      r1: { id: 'r1', name: 'Outer' },
      mid: { id: 'mid', name: 'Mid', parents: ['r1'] },
      r2: { id: 'r2', name: 'Inner', parents: ['mid'] },
      leaf: { id: 'leaf', name: 'Leaf', parents: ['r2'] },
    });
    // Both r1 and r2 are configured. The walk goes leaf → r2 first → match.
    const result = await resolveAncestry(client, 'leaf', [
      { id: 'r1', label: 'Outer' },
      { id: 'r2', label: 'Inner' },
    ]);
    expect(result.rootId).toBe('r2');
    expect(result.rootLabel).toBe('Inner');
    expect(result.chain.map((n) => n.id)).toEqual(['r2']);
    expect(result.scope.parentId).toBe('r2');
  });
});
