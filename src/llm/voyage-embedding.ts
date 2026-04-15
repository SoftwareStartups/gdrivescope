import { CliError } from '../utils/errors.js';
import type { EmbeddingProvider } from './embedding-provider.js';

const MODEL = Bun.env.GDRIVESCOPE_VOYAGE_MODEL ?? 'voyage-3-lite';
const BATCH = 128;
const DIMENSIONS = 512;

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions = DIMENSIONS;

  constructor(private apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      let response: Response;
      try {
        response = await fetch('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: MODEL, input: batch }),
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
        throw new CliError(
          `Voyage embedding call failed (status ${response.status}): ${text}`,
          'EMBED_CALL_FAILED'
        );
      }
      const json = (await response.json()) as VoyageResponse;
      for (const item of json.data) {
        out.push(item.embedding);
      }
    }
    return out;
  }
}
