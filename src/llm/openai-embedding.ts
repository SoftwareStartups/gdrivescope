import OpenAI from 'openai';
import { CliError } from '../utils/errors.js';
import type { EmbeddingProvider } from './embedding-provider.js';

const MODEL =
  Bun.env.GDRIVESCOPE_OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
const BATCH = 96;
const DIMENSIONS = 1536;

export class OpenaiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = DIMENSIONS;
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      try {
        const response = await this.client.embeddings.create({
          model: MODEL,
          input: batch,
        });
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
