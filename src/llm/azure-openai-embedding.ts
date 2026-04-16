import OpenAI, { AzureOpenAI } from 'openai';
import { CliError } from '../utils/errors.js';
import type { EmbeddingProvider } from './embedding-provider.js';

const BATCH = 96;

export interface AzureOpenaiEmbeddingOptions {
  apiKey: string;
  endpoint: string;
  apiVersion?: string;
  deployment?: string;
  model?: string;
  dimensions?: number;
}

export class AzureOpenaiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'azure-openai';
  readonly dimensions: number;
  private client: AzureOpenAI;
  private model: string;

  constructor(opts: AzureOpenaiEmbeddingOptions) {
    this.client = new AzureOpenAI({
      apiKey: opts.apiKey,
      endpoint: opts.endpoint,
      apiVersion: opts.apiVersion ?? '2024-06-01',
      deployment: opts.deployment,
    });
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dimensions = opts.dimensions ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      try {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: batch,
        });
        for (const item of response.data) {
          out.push(item.embedding);
        }
      } catch (err) {
        if (err instanceof OpenAI.APIError) {
          throw new CliError(
            `Azure OpenAI embedding call failed (status ${err.status}): ${err.message}`,
            'EMBED_CALL_FAILED'
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(
          `Azure OpenAI embedding call failed: ${msg}`,
          'EMBED_CALL_FAILED'
        );
      }
    }
    return out;
  }
}
