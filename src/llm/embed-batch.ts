import { withBackoff } from '../pipeline/concurrency.js';
import { CliError } from '../utils/errors.js';

export async function batchEmbed(
  texts: readonly string[],
  batchSize: number,
  callBatch: (batch: readonly string[]) => Promise<number[][]>
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await withBackoff(() => callBatch(batch));
    for (const v of vectors) out.push(v);
  }
  return out;
}

export interface ValidateProbeOptions {
  actual: number | undefined;
  declared: number;
  providerLabel: string;
  model: string;
  remediationHint: string;
}

export function validateProbeDimensions(opts: ValidateProbeOptions): void {
  if (!opts.actual) {
    throw new CliError(
      `${opts.providerLabel} returned an empty embedding probe response`,
      'EMBED_CALL_FAILED'
    );
  }
  if (opts.actual !== opts.declared) {
    throw new CliError(
      `${opts.providerLabel} model ${opts.model} produced ${opts.actual}-dim vectors, config declared ${opts.declared}-dim. ${opts.remediationHint}`,
      'EMBEDDING_DIM_MISMATCH'
    );
  }
}
