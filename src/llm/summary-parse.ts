import { CliError } from '../utils/errors.js';
import {
  CLASSIFICATION_VALUES,
  type Classification,
} from './classification.js';
import type { LlmSummary } from './provider.js';

export interface RawSummary {
  summary: string;
  classification: string;
  key_topics: string[];
}

export function validateRawSummary(
  providerName: string,
  raw: unknown
): LlmSummary {
  if (!raw || typeof raw !== 'object') {
    throw new CliError(
      `${providerName} returned malformed output`,
      'LLM_MALFORMED_OUTPUT'
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== 'string') {
    throw new CliError(
      `${providerName} response is missing required fields`,
      'LLM_MALFORMED_OUTPUT'
    );
  }
  const classification = (CLASSIFICATION_VALUES as readonly string[]).includes(
    obj.classification as string
  )
    ? (obj.classification as Classification)
    : ('other' as Classification);
  const keyTopics = Array.isArray(obj.key_topics)
    ? (obj.key_topics as string[])
    : [];
  return { summary: obj.summary, classification, keyTopics };
}
