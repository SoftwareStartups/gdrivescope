import type { drive_v3 } from '@googleapis/drive';

export interface FakeFile extends drive_v3.Schema$File {
  id: string;
  name: string;
  mimeType: string;
}

export interface FakeTree {
  root: FakeFile;
  children: Record<string, FakeFile[]>;
  // Standalone files referenced as shortcut targets (not children of any folder)
  targets?: Record<string, FakeFile>;
}

export interface CallCounters {
  getCalls: number;
  listCalls: number;
  listedFolders: string[];
}

export interface FakeDrive {
  client: drive_v3.Drive;
  counters: CallCounters;
}

interface GetParams {
  fileId: string;
  fields?: string;
}

interface ListParams {
  q: string;
  fields?: string;
  pageSize?: number;
  pageToken?: string;
}

function parseParentFromQ(q: string): string {
  const m = q.match(/^'([^']+)' in parents/);
  if (!m) throw new Error(`unsupported q: ${q}`);
  return m[1] ?? '';
}

function findFile(tree: FakeTree, id: string): FakeFile | undefined {
  if (tree.root.id === id) return tree.root;
  for (const list of Object.values(tree.children)) {
    for (const f of list) {
      if (f.id === id) return f;
    }
  }
  return tree.targets?.[id];
}

export function makeFakeDrive(tree: FakeTree): FakeDrive {
  const counters: CallCounters = {
    getCalls: 0,
    listCalls: 0,
    listedFolders: [],
  };

  const files = {
    async get(params: GetParams) {
      counters.getCalls += 1;
      const file = findFile(tree, params.fileId);
      if (!file) {
        throw new Error(`fake drive: no such file ${params.fileId}`);
      }
      return { data: file };
    },
    async list(params: ListParams) {
      counters.listCalls += 1;
      const parent = parseParentFromQ(params.q);
      counters.listedFolders.push(parent);
      const children = tree.children[parent] ?? [];
      return { data: { files: children } };
    },
  };

  const client = { files } as unknown as drive_v3.Drive;
  return { client, counters };
}
