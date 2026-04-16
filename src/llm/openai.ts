import OpenAI from 'openai';
import { CliError } from '../utils/errors.js';
import { SUMMARY_SYSTEM, summaryUser } from './prompts.js';
import type { LlmProvider, LlmSummarizeInput, LlmSummary } from './provider.js';
import { LLM_SUMMARY_SCHEMA } from './summary-schema.js';
import { validateRawSummary } from './summary-parse.js';

const MODEL = Bun.env.GDRIVESCOPE_OPENAI_MODEL ?? 'gpt-4.1-mini';

export class OpenaiProvider implements LlmProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async summarize(input: LlmSummarizeInput): Promise<LlmSummary> {
    let text: string | null | undefined;
    try {
      const response = await this.client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: summaryUser(input) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'LlmSummary',
            schema: LLM_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
            strict: true,
          },
        },
      });
      text = response.choices[0]?.message?.content;
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        throw new CliError(
          `OpenAI call failed (status ${err.status}): ${err.message}`,
          'LLM_CALL_FAILED'
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(`OpenAI call failed: ${msg}`, 'LLM_CALL_FAILED');
    }

    if (!text) {
      throw new CliError(
        'OpenAI returned empty content',
        'LLM_MALFORMED_OUTPUT'
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(
        `OpenAI returned invalid JSON: ${msg}`,
        'LLM_MALFORMED_OUTPUT'
      );
    }
    return validateRawSummary('OpenAI', parsed);
  }
}
