import { CLASSIFICATION_VALUES } from './classification.js';

export const LLM_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'classification', 'key_topics'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    classification: { type: 'string', enum: CLASSIFICATION_VALUES },
    key_topics: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 10,
    },
  },
} as const;
