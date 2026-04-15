import type {
  LlmProvider,
  LlmSummarizeInput,
  LlmSummary,
} from '../../src/llm/provider.js';

export type FakeLlmReply = (input: LlmSummarizeInput) => LlmSummary;

export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';
  readonly calls: LlmSummarizeInput[] = [];
  private reply: FakeLlmReply;

  constructor(reply?: FakeLlmReply) {
    this.reply =
      reply ??
      ((i) => ({
        summary: `Fake summary of ${i.filename}`,
        classification: 'other',
        keyTopics: ['fake'],
      }));
  }

  summarize(input: LlmSummarizeInput): Promise<LlmSummary> {
    this.calls.push(input);
    return Promise.resolve(this.reply(input));
  }
}
