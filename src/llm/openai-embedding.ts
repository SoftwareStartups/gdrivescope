import OpenAI from 'openai';
import { CliError } from '../utils/errors.js';
import type { EmbeddingProvider } from './embedding-provider.js';

const BATCH = 96;
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

export interface OpenaiEmbeddingOptions {
  apiKey: string;
  model?: string;
  /**
   * Vector width. When unset, the provider emits the model's native output
   * and declares 1536 dims. Override for non-1536 models (e.g.
   * `text-embedding-3-large` = 3072) or to request reduced output via the
   * API's `dimensions` parameter.
   */
  dimensions?: number;
}

export class OpenaiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  private client: OpenAI;
  private model: string;
  private explicitDimensions: number | undefined;

  constructor(opts: OpenaiEmbeddingOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
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
          `OpenAI embedding probe failed (status ${err.status}): ${err.message}`,
          'EMBED_CALL_FAILED'
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(
        `OpenAI embedding probe failed: ${msg}`,
        'EMBED_CALL_FAILED'
      );
    }
    const actual = response.data?.[0]?.embedding.length;
    if (!actual) {
      throw new CliError(
        'OpenAI returned an empty embedding probe response',
        'EMBED_CALL_FAILED'
      );
    }
    if (actual !== this.dimensions) {
      throw new CliError(
        `OpenAI model ${this.model} produced ${actual}-dim vectors, config declared ${this.dimensions}-dim. Set GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS=${actual} or pick a different model.`,
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
            `OpenAI embedding call failed (status ${err.status}): ${err.message}`,
            'EMBED_CALL_FAILED'
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError(
          `OpenAI embedding call failed: ${msg}`,
          'EMBED_CALL_FAILED'
        );
      }
    }
    return out;
  }
}
