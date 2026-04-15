import type { EmbeddingProvider } from '../../src/llm/embedding-provider.js';

// Deterministic, L2-normalised bag-of-characters projection. Gives
// predictable cosine-distance ordering for short strings without pulling
// a real embedding model into tests.
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions: number;
  public calls: string[][] = [];

  constructor(dimensions = 8) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((t) => {
      const vec = new Array<number>(this.dimensions).fill(0);
      for (let i = 0; i < t.length; i += 1) {
        vec[t.charCodeAt(i) % this.dimensions] += 1;
      }
      const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  }
}
