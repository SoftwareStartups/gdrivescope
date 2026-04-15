import { describe, expect, test } from 'bun:test';
import { CLASSIFICATION_VALUES } from '../../src/llm/classification.js';
import { SUMMARY_SYSTEM, summaryUser } from '../../src/llm/prompts.js';
import { LLM_SUMMARY_SCHEMA } from '../../src/llm/summary-schema.js';

describe('classification + summary schema', () => {
  test('exposes 11 fixed values', () => {
    expect(CLASSIFICATION_VALUES).toHaveLength(11);
    expect(CLASSIFICATION_VALUES).toContain('pitch_deck');
    expect(CLASSIFICATION_VALUES).toContain('other');
  });

  test('schema classification enum equals CLASSIFICATION_VALUES', () => {
    expect(LLM_SUMMARY_SCHEMA.properties.classification.enum).toEqual(
      CLASSIFICATION_VALUES
    );
  });

  test('schema forbids additional properties', () => {
    expect(LLM_SUMMARY_SCHEMA.additionalProperties).toBe(false);
  });

  test('schema requires all three fields', () => {
    expect(LLM_SUMMARY_SCHEMA.required).toEqual([
      'summary',
      'classification',
      'key_topics',
    ]);
  });
});

describe('summaryUser prompt builder', () => {
  test('includes filename and path', () => {
    const out = summaryUser({
      filename: 'plan.pdf',
      path: '/root/docs/plan.pdf',
      markdown: 'hello world',
    });
    expect(out).toContain('Filename: plan.pdf');
    expect(out).toContain('Path: /root/docs/plan.pdf');
    expect(out).toContain('hello world');
  });

  test('caps markdown snippet at 3000 chars', () => {
    const huge = 'x'.repeat(10_000);
    const out = summaryUser({ filename: 'a', path: 'a', markdown: huge });
    // The user message has a fixed header; the snippet portion should be exactly 3000 xs.
    expect(out.split('Content:\n')[1]?.length).toBe(3000);
  });

  test('SUMMARY_SYSTEM pins English output', () => {
    expect(SUMMARY_SYSTEM).toContain('English');
  });
});
