import { CliError } from '../utils/errors.js';
import { SUMMARY_SYSTEM, summaryUser } from './prompts.js';
import type { LlmProvider, LlmSummarizeInput, LlmSummary } from './provider.js';
import { LLM_SUMMARY_SCHEMA } from './summary-schema.js';
import { validateRawSummary } from './summary-parse.js';

interface OllamaChatResponse {
  message: { content: string };
}

export interface OllamaProviderOptions {
  host: string;
  model: string;
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  private host: string;
  private model: string;

  constructor(opts: OllamaProviderOptions) {
    this.host = opts.host;
    this.model = opts.model;
  }

  async summarize(input: LlmSummarizeInput): Promise<LlmSummary> {
    const messages = [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: summaryUser(input) },
    ];

    const doCall = async (
      msgs: Array<{ role: string; content: string }>
    ): Promise<OllamaChatResponse> => {
      let response: Response;
      try {
        response = await fetch(`${this.host}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            format: LLM_SUMMARY_SCHEMA,
            messages: msgs,
          }),
        });
      } catch (err) {
        if (err instanceof TypeError && err.message.includes('fetch failed')) {
          throw new CliError(
            `Ollama is not reachable at ${this.host}. Run \`ollama serve\` or \`gdrivescope ollama setup\`.`,
            'PROVIDER_UNAVAILABLE'
          );
        }
        throw err;
      }
      if (!response.ok) {
        throw new CliError(
          `Ollama ${response.status}: ${await response.text()}`,
          'LLM_CALL_FAILED'
        );
      }
      return (await response.json()) as OllamaChatResponse;
    };

    let parsed: unknown;
    try {
      const first = await doCall(messages);
      parsed = JSON.parse(first.message.content);
    } catch (err) {
      if (err instanceof CliError) throw err;
      const stricter = [
        {
          role: 'system',
          content: `${SUMMARY_SYSTEM}\n\nYour reply MUST be a JSON object matching the provided schema exactly. Do not include prose outside the JSON.`,
        },
        messages[1],
      ];
      try {
        const second = await doCall(stricter);
        parsed = JSON.parse(second.message.content);
      } catch (err2) {
        if (err2 instanceof CliError) throw err2;
        throw new CliError(
          `Ollama model ${this.model} did not return schema-conformant JSON on two attempts.`,
          'LLM_MALFORMED_OUTPUT'
        );
      }
    }
    return validateRawSummary('Ollama', parsed);
  }
}
