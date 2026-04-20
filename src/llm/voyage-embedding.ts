import { CliError } from '../utils/errors.js';
import { batchEmbed, validateProbeDimensions } from './embed-batch.js';
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

  private buildBody(input: string[]): VoyageRequestBody {
    const body: VoyageRequestBody = { model: this.model, input };
    if (this.explicitDimensions !== undefined) {
      body.output_dimension = this.explicitDimensions;
    }
    return body;
  }

  async probe(): Promise<void> {
    const json = await callVoyage(this.apiKey, this.buildBody(['probe']));
    validateProbeDimensions({
      actual: json.data?.[0]?.embedding.length,
      declared: this.dimensions,
      providerLabel: 'Voyage',
      model: this.model,
      remediationHint: `Set GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS=${json.data?.[0]?.embedding.length} or pick a different model.`,
    });
  }

  embed(texts: string[]): Promise<number[][]> {
    return batchEmbed(texts, BATCH, async (batch) => {
      const json = await callVoyage(this.apiKey, this.buildBody([...batch]));
      return json.data.map((item) => item.embedding);
    });
  }
}
