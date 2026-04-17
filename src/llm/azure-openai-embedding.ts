import OpenAI, { AzureOpenAI } from 'openai';
import { CliError } from '../utils/errors.js';
import type { EmbeddingProvider } from './embedding-provider.js';

const BATCH = 96;
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_API_VERSION = '2024-06-01';

export interface AzureOpenaiEmbeddingOptions {
  apiKey: string;
  endpoint: string;
  apiVersion?: string;
  deployment?: string;
  model?: string;
  /**
   * Vector width. Override for non-1536 deployments (e.g.
   * `text-embedding-3-large` = 3072) or to request reduced output via
   * the API's `dimensions` parameter.
   */
  dimensions?: number;
}

export class AzureOpenaiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'azure-openai';
  readonly dimensions: number;
  private client: AzureOpenAI;
  private model: string;
  private explicitDimensions: number | undefined;

  constructor(opts: AzureOpenaiEmbeddingOptions) {
    this.client = new AzureOpenAI({
      apiKey: opts.apiKey,
      endpoint: opts.endpoint,
      apiVersion: opts.apiVersion ?? DEFAULT_API_VERSION,
      deployment: opts.deployment,
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    this.explicitDimensions = opts.dimensions;
  }

  async probe(): Promise<void> {
    let response: OpenAI.Embeddings.CreateEmbeddingResponse;
    try {
      const params: OpenAI.Embeddings.EmbeddingCreateParams = {
        model: this.model,
        input: 'probe',
      };
      if (this.explicitDimensions !== undefined) {
        params.dimensions = this.explicitDimensions;
      }
      response = await this.client.embeddings.create(params);
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        throw new CliError(
          `Azure OpenAI embedding probe failed (status ${err.status}): ${err.message}`,
          'EMBED_CALL_FAILED'
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(
        `Azure OpenAI embedding probe failed: ${msg}`,
        'EMBED_CALL_FAILED'
      );
    }
    const actual = response.data?.[0]?.embedding.length;
    if (!actual) {
      throw new CliError(
        'Azure OpenAI returned an empty embedding probe response',
        'EMBED_CALL_FAILED'
      );
    }
    if (actual !== this.dimensions) {
      throw new CliError(
        `Azure OpenAI deployment produced ${actual}-dim vectors, config declared ${this.dimensions}-dim. Set GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS=${actual} or pick a different deployment.`,
        'EMBEDDING_DIM_MISMATCH'
      );
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      try {
        const params: OpenAI.Embeddings.EmbeddingCreateParams = {
          model: this.model,
          input: batch,
        };
        if (this.explicitDimensions !== undefined) {
          params.dimensions = this.explicitDimensions;
        }
        const response = await this.client.embeddings.create(params);
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
