import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from '../../config/workspace.js';
import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { CliError, toResponse } from '../../utils/errors.js';

export interface OllamaSetupFlags {
  host?: string;
  'llm-model'?: string;
  'embedding-model'?: string;
  'skip-pull'?: boolean;
}

export interface OllamaSetupData {
  host: string;
  llmModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  configPath: string;
}

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_LLM = 'llama3.2:3b-instruct';
const DEFAULT_EMBED = 'nomic-embed-text';

export const HELP = `gdrivescope ollama setup — Configure local Ollama for gdrivescope

Probes a running Ollama instance, pulls the required models if missing,
validates both chat and embedding endpoints, and writes the chosen settings
into config.toml.

Usage:
  gdrivescope ollama setup [options]

Options:
  --host <URL>               Ollama base URL (default http://localhost:11434)
  --llm-model <NAME>         LLM model to install (default llama3.2:3b-instruct)
  --embedding-model <NAME>   Embedding model (default nomic-embed-text)
  --skip-pull                Assume models are already installed
  --json                     Emit JSON envelope
`;

async function probe(host: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${host}/api/tags`);
  } catch {
    throw new CliError(
      `Ollama not responding at ${host}. Install from https://ollama.com/download and run \`ollama serve\`.`,
      'PROVIDER_UNAVAILABLE'
    );
  }
  if (!response.ok) {
    throw new CliError(
      `Ollama /api/tags returned ${response.status}`,
      'PROVIDER_UNAVAILABLE'
    );
  }
  const json = (await response.json()) as { models: Array<{ name: string }> };
  return json.models.map((m) => m.name);
}

function pullModel(model: string): void {
  const res = Bun.spawnSync({
    cmd: ['ollama', 'pull', model],
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  if (res.exitCode !== 0) {
    throw new CliError(
      `\`ollama pull ${model}\` exited with code ${res.exitCode}`,
      'OLLAMA_PULL_FAILED'
    );
  }
}

async function validate(
  host: string,
  llmModel: string,
  embedModel: string
): Promise<number> {
  const embedRes = await fetch(`${host}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embedModel, input: 'hello' }),
  });
  if (!embedRes.ok) {
    throw new CliError(
      `Ollama /api/embed returned ${embedRes.status}`,
      'EMBED_CALL_FAILED'
    );
  }
  const embedJson = (await embedRes.json()) as { embeddings: number[][] };
  const dims = embedJson.embeddings?.[0]?.length;
  if (!dims) {
    throw new CliError(
      'Embedding response missing vector',
      'EMBED_CALL_FAILED'
    );
  }

  const chatRes = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: llmModel,
      stream: false,
      messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
    }),
  });
  if (!chatRes.ok) {
    throw new CliError(
      `Ollama /api/chat returned ${chatRes.status}`,
      'LLM_CALL_FAILED'
    );
  }

  return dims;
}

export async function run(
  flags: OllamaSetupFlags
): Promise<ApiResponse<OllamaSetupData>> {
  const host = flags.host ?? DEFAULT_HOST;
  const llmModel = flags['llm-model'] ?? DEFAULT_LLM;
  const embedModel = flags['embedding-model'] ?? DEFAULT_EMBED;

  try {
    const installed = await probe(host);

    if (!flags['skip-pull']) {
      if (!installed.some((n) => n.startsWith(llmModel))) {
        pullModel(llmModel);
      }
      if (!installed.some((n) => n.startsWith(embedModel))) {
        pullModel(embedModel);
      }
    }

    const dims = await validate(host, llmModel, embedModel);

    const cfg = await loadWorkspaceConfig();
    cfg.ollama = {
      host,
      llmModel,
      embeddingModel: embedModel,
      embeddingDimensions: dims,
    };
    const cfgPath = await saveWorkspaceConfig(cfg);

    return success({
      host,
      llmModel,
      embeddingModel: embedModel,
      embeddingDimensions: dims,
      configPath: cfgPath,
    });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: OllamaSetupData): string {
  return [
    'Ollama configured successfully',
    `  host:                ${data.host}`,
    `  llm model:           ${data.llmModel}`,
    `  embedding model:     ${data.embeddingModel}`,
    `  embedding dims:      ${data.embeddingDimensions}`,
    `  config:              ${data.configPath}`,
  ].join('\n');
}
