import { CliError } from '../utils/errors.js';
import type { EmbeddingProvider } from './embedding-provider.js';

const BATCH = 64;

export interface OllamaEmbeddingOptions {
  host: string;
  model: string;
  dimensions: number;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly dimensions: number;
  private host: string;
  private model: string;

  constructor(opts: OllamaEmbeddingOptions) {
    this.host = opts.host;
    this.model = opts.model;
    this.dimensions = opts.dimensions;
  }

  static async probeDimension(
    host: string,
    model: string,
    declaredDims: number
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${host}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: 'probe' }),
      });
    } catch {
      throw new CliError(
        `Ollama is not reachable at ${host}. Run \`ollama serve\` or \`gdrivescope ollama setup\`.`,
        'PROVIDER_UNAVAILABLE'
      );
    }
    if (!response.ok) {
      throw new CliError(
        `Ollama /api/embed returned ${response.status}`,
        'EMBED_CALL_FAILED'
      );
    }
    const json = (await response.json()) as { embeddings: number[][] };
    const actual = json.embeddings?.[0]?.length;
    if (!actual) {
      throw new CliError('Empty embedding response', 'EMBED_CALL_FAILED');
    }
    if (actual !== declaredDims) {
      throw new CliError(
        `Ollama model ${model} produced ${actual}-dim vectors, config declared ${declaredDims}-dim. Run \`gdrivescope ollama setup\` to reconcile.`,
        'EMBEDDING_DIM_MISMATCH'
      );
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      let response: Response;
      try {
        response = await fetch(`${this.host}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: batch }),
        });
      } catch {
        throw new CliError(
          `Ollama is not reachable at ${this.host}. Run \`ollama serve\` or \`gdrivescope ollama setup\`.`,
          'PROVIDER_UNAVAILABLE'
        );
      }
      if (!response.ok) {
        throw new CliError(
          `Ollama /api/embed returned ${response.status}`,
          'EMBED_CALL_FAILED'
        );
      }
      const json = (await response.json()) as { embeddings: number[][] };
      out.push(...json.embeddings);
    }
    return out;
  }
}
