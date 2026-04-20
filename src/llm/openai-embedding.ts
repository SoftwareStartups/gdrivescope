import OpenAI from 'openai';
import { withBackoff } from '../pipeline/concurrency.js';
import { CliError } from '../utils/errors.js';
import { batchEmbed, validateProbeDimensions } from './embed-batch.js';
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

  private buildParams(
    input: string | string[]
  ): OpenAI.Embeddings.EmbeddingCreateParams {
    const params: OpenAI.Embeddings.EmbeddingCreateParams = {
      model: this.model,
      input,
    };
    if (this.explicitDimensions !== undefined) {
      params.dimensions = this.explicitDimensions;
    }
    return params;
  }

  async probe(): Promise<void> {
    let response: OpenAI.Embeddings.CreateEmbeddingResponse;
    try {
      response = await this.client.embeddings.create(this.buildParams('probe'));
    } catch (err) {
      throw wrapOpenaiError('OpenAI embedding probe failed', err);
    }
    validateProbeDimensions({
      actual: response.data?.[0]?.embedding.length,
      declared: this.dimensions,
      providerLabel: 'OpenAI',
      model: this.model,
      remediationHint: `Set GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS=${response.data?.[0]?.embedding.length} or pick a different model.`,
    });
  }

  embed(texts: string[]): Promise<number[][]> {
    return batchEmbed(texts, BATCH, async (batch) => {
      try {
        const response = await withBackoff(() =>
          this.client.embeddings.create(this.buildParams([...batch]))
        );
        return response.data.map((item) => item.embedding);
      } catch (err) {
        throw wrapOpenaiError('OpenAI embedding call failed', err);
      }
    });
  }
}

function wrapOpenaiError(prefix: string, err: unknown): CliError {
  if (err instanceof OpenAI.APIError) {
    return new CliError(
      `${prefix} (status ${err.status}): ${err.message}`,
      'EMBED_CALL_FAILED'
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new CliError(`${prefix}: ${msg}`, 'EMBED_CALL_FAILED');
}
