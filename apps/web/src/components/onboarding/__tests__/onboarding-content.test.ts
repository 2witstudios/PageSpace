import { describe, expect, test } from 'vitest';
import {
  SCALES,
  SCALE_CONTENT,
  SCALE_OPTIONS,
  getExamples,
  getScaleLabel,
} from '../onboarding-content';

describe('scale content completeness', () => {
  test.each(SCALES)('%s has every field filled', (scale) => {
    const content = SCALE_CONTENT[scale];
    expect(content.workspaceNoun.trim()).not.toBe('');
    expect(content.sampleRequest.trim()).not.toBe('');
    expect(content.sampleReply.trim()).not.toBe('');
    expect(content.escalation.trim()).not.toBe('');
    expect(content.keeper.trim()).not.toBe('');
    expect(content.outcomes).toHaveLength(6);
    content.outcomes.forEach((o) => expect(o.trim()).not.toBe(''));
    expect(content.examples.length).toBeGreaterThanOrEqual(5);
    content.examples.forEach((e) => expect(e.text.trim()).not.toBe(''));
  });

  test('every scale option has content, and every content entry has an option', () => {
    expect(SCALE_OPTIONS.map((o) => o.id).sort()).toEqual([...SCALES].sort());
  });

  test('assistant count rises strictly with scale, so the escalation reads as escalation', () => {
    const counts = SCALES.map((s) => SCALE_CONTENT[s].assistantCount);
    const ascending = counts.every((n, i) => i === 0 || n > counts[i - 1]);
    expect(ascending).toBe(true);
  });
});

describe('deployment-mode gating', () => {
  test('keeps every example when cloud integrations are allowed', () => {
    for (const scale of SCALES) {
      expect(getExamples(scale, true)).toHaveLength(SCALE_CONTENT[scale].examples.length);
    }
  });

  test('drops examples that need external integrations on onprem', () => {
    // The concrete failure this prevents: an onprem user is offered "Get my team
    // off Slack and organised" as their very first request, and it cannot work.
    const smallOnPrem = getExamples('small', false);
    expect(smallOnPrem.some((e) => e.text.includes('Slack'))).toBe(false);
    expect(getExamples('small', true).some((e) => e.text.includes('Slack'))).toBe(true);
  });

  test('every scale still offers usable examples on onprem, never an empty list', () => {
    for (const scale of SCALES) {
      expect(getExamples(scale, false).length).toBeGreaterThan(0);
    }
  });
});

describe('getScaleLabel', () => {
  test('returns the human description used when writing to memory', () => {
    expect(getScaleLabel('small')).toBe('A small business or a tight team');
  });
});
