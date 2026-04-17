import { CliError } from '../utils/errors.js';
import type { EmbeddingProvider } from './embedding-provider.js';

const BATCH = 128;
const DEFAULT_MODEL = 'voyage-3-lite';
const DEFAULT_DIMENSIONS = 512;
const API_URL = 'https://api.voyageai.com/v1/embeddings';

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
}

export interface VoyageEmbeddingOptions {
  apiKey: string;
  model?: string;
  /**
   * Vector width. Override for non-512 models (e.g. `voyage-3` = 1024)
   * or to request reduced output via Voyage's `output_dimension` param.
   */
  dimensions?: number;
}

interface VoyageRequestBody {
  model: string;
  input: string[];
  output_dimension?: number;
}

async function callVoyage(
  apiKey: string,
  body: VoyageRequestBody
): Promise<VoyageResponse> {
  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Voyage embedding call failed: ${msg}`,
      'EMBED_CALL_FAILED'
    );
  }
  if (!response.ok) {
    const text = await response.text();
    if (Bun.env.DEBUG) {
      process.stderr.write(`[debug] Voyage API response: ${text}\n`);
    }
    throw new CliError(
      `Voyage embedding failed (HTTP ${response.status}). Run with DEBUG=1 for details.`,
      'EMBED_CALL_FAILED'
    );
  }
  return (await response.json()) as VoyageResponse;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions: number;
  private apiKey: string;
  private model: string;
  private explicitDimensions: number | undefined;

  constructor(opts: VoyageEmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    this.explicitDimensions = opts.dimensions;
  }

  async probe(): Promise<void> {
    const body: VoyageRequestBody = { model: this.model, input: ['probe'] };
    if (this.explicitDimensions !== undefined) {
      body.output_dimension = this.explicitDimensions;
    }
    const json = await callVoyage(this.apiKey, body);
    const actual = json.data?.[0]?.embedding.length;
    if (!actual) {
      throw new CliError(
        'Voyage returned an empty embedding probe response',
        'EMBED_CALL_FAILED'
      );
    }
    if (actual !== this.dimensions) {
      throw new CliError(
        `Voyage model ${this.model} produced ${actual}-dim vectors, config declared ${this.dimensions}-dim. Set GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS=${actual} or pick a different model.`,
        'EMBEDDING_DIM_MISMATCH'
      );
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const body: VoyageRequestBody = { model: this.model, input: batch };
      if (this.explicitDimensions !== undefined) {
        body.output_dimension = this.explicitDimensions;
      }
      const json = await callVoyage(this.apiKey, body);
      for (const item of json.data) {
        out.push(item.embedding);
      }
    }
    return out;
  }
}
