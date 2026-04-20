import OpenAI, { AzureOpenAI } from 'openai';
import { withBackoff } from '../pipeline/concurrency.js';
import { CliError } from '../utils/errors.js';
import { batchEmbed, validateProbeDimensions } from './embed-batch.js';
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
      throw wrapAzureError('Azure OpenAI embedding probe failed', err);
    }
    validateProbeDimensions({
      actual: response.data?.[0]?.embedding.length,
      declared: this.dimensions,
      providerLabel: 'Azure OpenAI',
      model: this.model,
      remediationHint: `Set GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS=${response.data?.[0]?.embedding.length} or pick a different deployment.`,
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
        throw wrapAzureError('Azure OpenAI embedding call failed', err);
      }
    });
  }
}

function wrapAzureError(prefix: string, err: unknown): CliError {
  if (err instanceof OpenAI.APIError) {
    return new CliError(
      `${prefix} (status ${err.status}): ${err.message}`,
      'EMBED_CALL_FAILED'
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new CliError(`${prefix}: ${msg}`, 'EMBED_CALL_FAILED');
}
