import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findRoot,
  loadWorkspaceConfig,
  removeRoot,
  resolveFolder,
  saveWorkspaceConfig,
  upsertRoot,
  type WorkspaceConfig,
} from '../../src/config/workspace.js';

describe('workspace config', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gdrivescope-cfg-'));
    configPath = join(tmpDir, 'config.toml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('missing file → empty config', async () => {
    const cfg = await loadWorkspaceConfig(configPath);
    expect(cfg.roots).toEqual([]);
    expect(cfg.folders).toEqual({});
  });

  test('save + load round-trips roots and folder aliases', async () => {
    const input: WorkspaceConfig = {
      roots: [
        { id: '0ABC', label: 'Company' },
        { id: 'root', label: 'Personal' },
      ],
      folders: { acme: '1xyzAcme', 'q4-review': '1xyzQ4' },
    };
    const written = await saveWorkspaceConfig(input, configPath);
    expect(written).toBe(configPath);

    const loaded = await loadWorkspaceConfig(configPath);
    expect(loaded.roots).toEqual(input.roots);
    expect(loaded.folders).toEqual(input.folders);
  });

  test('saved file contains TOML headers for roots and folders', async () => {
    await saveWorkspaceConfig(
      {
        roots: [{ id: '0ABC', label: 'Company' }],
        folders: { acme: '1xyzAcme' },
      },
      configPath
    );
    const text = await Bun.file(configPath).text();
    expect(text).toContain('[[roots]]');
    expect(text).toContain('[folders]');
    expect(text).toContain('0ABC');
    expect(text).toContain('acme');
  });

  test('empty config writes a minimal stub without crashing', async () => {
    await saveWorkspaceConfig({ roots: [], folders: {} }, configPath);
    const text = await Bun.file(configPath).text();
    expect(text).toContain('gdrivescope config');
    const reloaded = await loadWorkspaceConfig(configPath);
    expect(reloaded.roots).toEqual([]);
    expect(reloaded.folders).toEqual({});
  });

  test('resolveFolder looks up aliases, falls back to raw id', () => {
    const cfg: WorkspaceConfig = {
      roots: [],
      folders: { acme: '1xyzAcme' },
    };
    expect(resolveFolder(cfg, 'acme')).toBe('1xyzAcme');
    expect(resolveFolder(cfg, 'unmapped')).toBe('unmapped');
  });

  test('upsertRoot replaces existing id, appends new ones', () => {
    const cfg: WorkspaceConfig = {
      roots: [{ id: 'A', label: 'Old' }],
      folders: {},
    };
    const updated = upsertRoot(cfg, { id: 'A', label: 'New' });
    expect(updated.roots).toEqual([{ id: 'A', label: 'New' }]);

    const withSecond = upsertRoot(updated, { id: 'B' });
    expect(withSecond.roots.map((r) => r.id)).toEqual(['A', 'B']);
  });

  test('removeRoot drops matching id, leaves others intact', () => {
    const cfg: WorkspaceConfig = {
      roots: [
        { id: 'A', label: 'Alpha' },
        { id: 'B', label: 'Bravo' },
      ],
      folders: {},
    };
    const updated = removeRoot(cfg, 'A');
    expect(updated.roots.map((r) => r.id)).toEqual(['B']);
  });

  test('findRoot locates by id', () => {
    const cfg: WorkspaceConfig = {
      roots: [{ id: 'A', label: 'Alpha' }],
      folders: {},
    };
    expect(findRoot(cfg, 'A')?.label).toBe('Alpha');
    expect(findRoot(cfg, 'B')).toBeUndefined();
  });

  test('malformed TOML entries are skipped rather than throwing', async () => {
    const body = `# gdrivescope config

[[roots]]
id = "good"
label = "Good"

[[roots]]
# missing id

[folders]
acme = "1xyzAcme"
nope = 42
`;
    await Bun.write(configPath, body);
    const loaded = await loadWorkspaceConfig(configPath);
    expect(loaded.roots).toEqual([{ id: 'good', label: 'Good' }]);
    // `nope = 42` should be filtered out because it's not a string.
    expect(loaded.folders).toEqual({ acme: '1xyzAcme' });
  });
});
