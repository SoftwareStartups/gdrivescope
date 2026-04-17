import { describe, expect, test } from 'bun:test';
import { traverseDriveFolder } from '../../src/drive/traversal.js';
import type { DriveNodeInput } from '../../src/graph/model.js';
import { type FakeTree, makeFakeDrive } from '../helpers/fakeDrive.js';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

function buildTree(): FakeTree {
  return {
    root: { id: 'root', name: 'Root', mimeType: FOLDER },
    children: {
      root: [
        { id: 'docs', name: 'Docs', mimeType: FOLDER },
        { id: 'images', name: 'Images', mimeType: FOLDER },
        {
          id: 'sc1',
          name: 'report-shortcut',
          mimeType: SHORTCUT,
          shortcutDetails: {
            targetId: 'report',
            targetMimeType: 'application/pdf',
          },
        },
      ],
      docs: [
        {
          id: 'report',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          size: '12345',
        },
        { id: 'notes', name: 'notes.md', mimeType: 'text/markdown' },
      ],
      images: [{ id: 'logo', name: 'logo.png', mimeType: 'image/png' }],
    },
  };
}

describe('traverseDriveFolder', () => {
  test('walks folders, files, and resolves shortcuts', async () => {
    const { client, counters } = makeFakeDrive(buildTree());
    const collected: DriveNodeInput[] = [];

    const result = await traverseDriveFolder(client, {
      rootId: 'root',
      onNode: (n) => {
        collected.push(n);
      },
    });

    // 1 root + 2 subfolders + 2 files under docs + 1 file under images + 1 shortcut = 7
    expect(result.visited).toBe(7);
    expect(result.folders).toBe(3);
    expect(result.files).toBe(4);
    expect(collected).toHaveLength(7);

    // Shortcut node keeps its own id + parent but takes target mimeType.
    const shortcut = collected.find((n) => n.id === 'sc1');
    expect(shortcut).toBeDefined();
    expect(shortcut?.parentId).toBe('root');
    expect(shortcut?.mimeType).toBe('application/pdf');
    expect(shortcut?.name).toBe('report.pdf');

    // Listing should have touched only real folder ids — never a file or the shortcut target.
    expect(counters.listedFolders.sort()).toEqual(['docs', 'images', 'root']);
    // files.get calls: 1 for root + 1 to resolve the shortcut target.
    expect(counters.getCalls).toBe(2);
  });

  test('clamps concurrency but still completes', async () => {
    const { client } = makeFakeDrive(buildTree());
    const result = await traverseDriveFolder(client, {
      rootId: 'root',
      concurrency: 100,
      onNode: () => {},
    });
    expect(result.visited).toBe(7);
  });

  test('second run with the same fake produces identical counts', async () => {
    const tree = buildTree();
    const { client } = makeFakeDrive(tree);
    const first = await traverseDriveFolder(client, {
      rootId: 'root',
      onNode: () => {},
    });
    const { client: client2 } = makeFakeDrive(tree);
    const second = await traverseDriveFolder(client2, {
      rootId: 'root',
      onNode: () => {},
    });
    expect(first).toEqual(second);
  });

  test('folder shortcuts: BFS descends into the target folder', async () => {
    const tree: FakeTree = {
      root: { id: 'root', name: 'Root', mimeType: FOLDER },
      children: {
        root: [
          {
            id: 'sc-folder',
            name: 'shared-folder-shortcut',
            mimeType: SHORTCUT,
            shortcutDetails: {
              targetId: 'target-folder',
              targetMimeType: FOLDER,
            },
          },
        ],
        'target-folder': [
          {
            id: 'inside',
            name: 'inside.pdf',
            mimeType: 'application/pdf',
            size: '100',
          },
        ],
      },
      targets: {
        'target-folder': {
          id: 'target-folder',
          name: 'Shared Folder',
          mimeType: FOLDER,
        },
      },
    };
    const { client, counters } = makeFakeDrive(tree);
    const collected: DriveNodeInput[] = [];
    const result = await traverseDriveFolder(client, {
      rootId: 'root',
      onNode: (n) => {
        collected.push(n);
      },
    });

    // root + shortcut-as-folder + inside.pdf = 3 visited
    expect(result.visited).toBe(3);
    expect(result.folders).toBe(2);
    expect(result.files).toBe(1);

    // The PDF inside the target folder is indexed (bug fix: previously dropped).
    expect(collected.map((n) => n.id).sort()).toEqual([
      'inside',
      'root',
      'sc-folder',
    ]);
    // BFS listed the target folder's contents, not the shortcut's id.
    expect(counters.listedFolders.sort()).toEqual(['root', 'target-folder']);
    // inside.pdf is anchored to the shortcut as its parent (traversal emits it
    // with the id BFS used to fetch it, i.e. the target folder).
    const inside = collected.find((n) => n.id === 'inside');
    expect(inside?.parentId).toBe('target-folder');
  });
});
