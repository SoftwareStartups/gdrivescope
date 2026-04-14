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
});
