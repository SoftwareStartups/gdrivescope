import Anthropic from '@anthropic-ai/sdk';
import { CliError } from '../utils/errors.js';
import { SUMMARY_SYSTEM, summaryUser } from './prompts.js';
import type { LlmProvider, LlmSummarizeInput, LlmSummary } from './provider.js';
import { LLM_SUMMARY_SCHEMA } from './summary-schema.js';
import { validateRawSummary } from './summary-parse.js';

const MODEL = Bun.env.GDRIVESCOPE_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async summarize(input: LlmSummarizeInput): Promise<LlmSummary> {
    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: SUMMARY_SYSTEM,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [
          {
            name: 'record_summary',
            description: 'Record a structured summary of the document.',
            input_schema:
              LLM_SUMMARY_SCHEMA as unknown as Anthropic.Messages.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: 'record_summary' },
        messages: [{ role: 'user', content: summaryUser(input) }],
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new CliError(
          `Anthropic call failed (status ${err.status}): ${err.message}`,
          'LLM_CALL_FAILED'
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(`Anthropic call failed: ${msg}`, 'LLM_CALL_FAILED');
    }

    const toolUse = response.content.find(
      (c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use'
    );
    if (!toolUse) {
      throw new CliError(
        'Anthropic did not return a tool_use block',
        'LLM_MALFORMED_OUTPUT'
      );
    }
    return validateRawSummary('Anthropic', toolUse.input);
  }
}
