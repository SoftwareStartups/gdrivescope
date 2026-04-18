import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { run } from '../../src/cli/commands/show.js';
import { nodeInput } from '../helpers/makeStore.js';
import {
  type TempDbContext,
  seedTempDb,
  useTempDb,
} from '../helpers/tempDb.js';

describe('show command', () => {
  let ctx: TempDbContext;

  beforeEach(() => {
    ctx = useTempDb('show');
    seedTempDb(ctx.dbPath, [
      nodeInput({ id: 'root', name: 'My Drive', parentId: null }),
      nodeInput({
        id: 'report',
        name: 'report.pdf',
        parentId: 'root',
        mimeType: 'application/pdf',
        size: 2048,
        metadata: { driveId: 'root', owners: ['alice'] },
      }),
    ]);
  });

  afterEach(() => ctx.cleanup());

  test('returns a node with parsed metadata and a path', async () => {
    const response = await run({ _positional: 'report' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.path).toBe('My Drive/report.pdf');
    expect(response.data.node.id).toBe('report');
    expect(response.data.node.mimeType).toBe('application/pdf');
    expect(response.data.node.metadata).toEqual({
      driveId: 'root',
      owners: ['alice'],
    });
    // metadataJson should not leak on the parsed shape
    expect(
      (response.data.node as unknown as { metadataJson?: string }).metadataJson
    ).toBeUndefined();
  });

  test('missing positional → MISSING_ARG', async () => {
    const response = await run({});
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.code).toBe('MISSING_ARG');
  });

  test('unknown id → NODE_NOT_FOUND', async () => {
    const response = await run({ _positional: 'ghost' });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.code).toBe('NODE_NOT_FOUND');
  });
});
