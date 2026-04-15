import type { DirectedGraph } from 'graphology';

export interface DriveNodeInput {
  id: string;
  parentId: string | null;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  createdTime?: string;
  webViewLink?: string;
  rootId?: string | null;
  metadata: Record<string, unknown>;
}

export interface Node {
  id: string;
  parentId: string | null;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  createdTime?: string;
  webViewLink?: string;
  rootId: string | null;
  metadataJson: string;
  summary: string | null;
  classification: string | null;
  keyTopics: string | null;
  extractedMd: string | null;
  contentHash: string | null;
  lastIndexed: string | null;
}

export type EdgeAttrs = Record<string, never>;

export type DriveGraph = DirectedGraph<Node, EdgeAttrs>;
