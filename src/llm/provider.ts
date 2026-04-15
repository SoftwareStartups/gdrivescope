import type { Classification } from './classification.js';

export interface LlmSummary {
  summary: string;
  classification: Classification;
  keyTopics: string[];
}

export interface LlmSummarizeInput {
  markdown: string;
  filename: string;
  path: string;
  mimeType: string;
}

export interface LlmProvider {
  readonly name: string;
  summarize(input: LlmSummarizeInput): Promise<LlmSummary>;
}
