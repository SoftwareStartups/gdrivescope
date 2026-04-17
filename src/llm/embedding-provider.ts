export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Optional: validate that the configured model/deployment actually
   * produces vectors matching `dimensions`. Pipelines should call this
   * before `initVectorTable` so a mismatched config fails fast, before
   * any LLM summarization spend is paid.
   */
  probe?(): Promise<void>;
}
