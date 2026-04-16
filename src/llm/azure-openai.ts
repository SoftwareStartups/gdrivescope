import OpenAI, { AzureOpenAI } from 'openai';
import { CliError } from '../utils/errors.js';
import { SUMMARY_SYSTEM, summaryUser } from './prompts.js';
import type { LlmProvider, LlmSummarizeInput, LlmSummary } from './provider.js';
import { LLM_SUMMARY_SCHEMA } from './summary-schema.js';
import { validateRawSummary } from './summary-parse.js';

export interface AzureOpenaiProviderOptions {
  apiKey: string;
  endpoint: string;
  apiVersion?: string;
  deployment?: string;
  model?: string;
}

export class AzureOpenaiProvider implements LlmProvider {
  readonly name = 'azure-openai';
  private client: AzureOpenAI;
  private model: string;

  constructor(opts: AzureOpenaiProviderOptions) {
    this.client = new AzureOpenAI({
      apiKey: opts.apiKey,
      endpoint: opts.endpoint,
      apiVersion: opts.apiVersion ?? '2024-06-01',
      deployment: opts.deployment,
    });
    this.model = opts.model ?? 'gpt-5.4-nano';
  }

  async summarize(input: LlmSummarizeInput): Promise<LlmSummary> {
    let text: string | null | undefined;
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
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
          `Azure OpenAI call failed (status ${err.status}): ${err.message}`,
          'LLM_CALL_FAILED'
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(`Azure OpenAI call failed: ${msg}`, 'LLM_CALL_FAILED');
    }

    if (!text) {
      throw new CliError(
        'Azure OpenAI returned empty content',
        'LLM_MALFORMED_OUTPUT'
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(
        `Azure OpenAI returned invalid JSON: ${msg}`,
        'LLM_MALFORMED_OUTPUT'
      );
    }
    return validateRawSummary('Azure OpenAI', parsed);
  }
}
