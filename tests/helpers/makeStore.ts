import type { DriveNodeInput } from '../../src/graph/model.js';
import { openStore, type Store } from '../../src/graph/store.js';

export function seedStore(nodes: DriveNodeInput[]): Store {
  const store = openStore(':memory:');
  for (const node of nodes) {
    store.upsertNode(node);
  }
  return store;
}

export function nodeInput(
  overrides: Partial<DriveNodeInput> & Pick<DriveNodeInput, 'id'>
): DriveNodeInput {
  return {
    parentId: null,
    name: overrides.id,
    mimeType: 'application/vnd.google-apps.folder',
    metadata: {},
    ...overrides,
  };
}
