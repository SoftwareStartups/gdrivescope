import { CliError } from '../utils/errors.js';
import { batchEmbed, validateProbeDimensions } from './embed-batch.js';
import type { EmbeddingProvider } from './embedding-provider.js';

const BATCH = 64;

export interface OllamaEmbeddingOptions {
  host: string;
  model: string;
  dimensions: number;
}

async function callOllamaEmbed(
  host: string,
  model: string,
  input: string | string[]
): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(`${host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
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
  return json.embeddings ?? [];
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

  probe(): Promise<void> {
    return OllamaEmbeddingProvider.probeDimension(
      this.host,
      this.model,
      this.dimensions
    );
  }

  static async probeDimension(
    host: string,
    model: string,
    declaredDims: number
  ): Promise<void> {
    const vectors = await callOllamaEmbed(host, model, 'probe');
    validateProbeDimensions({
      actual: vectors[0]?.length,
      declared: declaredDims,
      providerLabel: 'Ollama',
      model,
      remediationHint: 'Run `gdrivescope ollama setup` to reconcile.',
    });
  }

  embed(texts: string[]): Promise<number[][]> {
    return batchEmbed(texts, BATCH, (batch) =>
      callOllamaEmbed(this.host, this.model, [...batch])
    );
  }
}
