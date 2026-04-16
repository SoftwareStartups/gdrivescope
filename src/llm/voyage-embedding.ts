import { CliError } from '../utils/errors.js';
import type { EmbeddingProvider } from './embedding-provider.js';

const BATCH = 128;

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions = 512;
  private apiKey: string;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'voyage-3-lite';
  }

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
          body: JSON.stringify({ model: this.model, input: batch }),
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
      const json = (await response.json()) as VoyageResponse;
      for (const item of json.data) {
        out.push(item.embedding);
      }
    }
    return out;
  }
}
