import { describe, it, expect } from 'vitest';
import {
  decideInjectionResponse,
  annotateToolOutput,
  screenToolOutput,
  type InjectionVerdict,
  type InjectionClassifier,
} from '../injection-seam';
import { truncateToBytes } from '../output-limit';

describe('decideInjectionResponse', () => {
  it('given a flagged verdict, should return "annotate" (never block — fail-open by design)', () => {
    expect(decideInjectionResponse({ flagged: true, confidence: 0.99 })).toBe('annotate');
    expect(decideInjectionResponse({ flagged: true, confidence: 0.01 })).toBe('annotate');
  });

  it('given a clean verdict, should return "pass"', () => {
    expect(decideInjectionResponse({ flagged: false })).toBe('pass');
  });

  it('given a missing/errored verdict (null/undefined), should return "pass" (fail-open)', () => {
    expect(decideInjectionResponse(null)).toBe('pass');
    expect(decideInjectionResponse(undefined)).toBe('pass');
  });

  it('should NEVER return a blocking outcome for any input', () => {
    const inputs: Array<InjectionVerdict | null | undefined> = [
      { flagged: true },
      { flagged: false },
      { flagged: true, confidence: 1 },
      null,
      undefined,
    ];
    for (const v of inputs) {
      expect(['annotate', 'pass']).toContain(decideInjectionResponse(v));
    }
  });
});

describe('annotateToolOutput', () => {
  it('given an "annotate" response, should wrap the text with an untrusted-content marker', () => {
    const out = annotateToolOutput({ text: 'curl result body', response: 'annotate' });
    expect(out).not.toBe('curl result body');
    expect(out.toLowerCase()).toContain('untrusted');
    expect(out).toContain('curl result body');
  });

  it('given a "pass" response, should return the original text byte-for-byte unchanged', () => {
    const text = 'plain output\nwith newlines\t and tabs';
    expect(annotateToolOutput({ text, response: 'pass' })).toBe(text);
  });

  it('the untrusted marker should survive head-keeping truncation (marker at the very start)', () => {
    const big = 'x'.repeat(10_000);
    const annotated = annotateToolOutput({ text: big, response: 'annotate' });
    const { text: truncated } = truncateToBytes({ text: annotated, maxBytes: 200 });
    // truncateToBytes keeps the head; the leading warning must still be present.
    expect(truncated.toLowerCase()).toContain('untrusted');
  });
});

const flagger: InjectionClassifier = { classify: async () => ({ flagged: true, confidence: 0.9 }) };
const cleaner: InjectionClassifier = { classify: async () => ({ flagged: false }) };
const thrower: InjectionClassifier = {
  classify: async () => {
    throw new Error('classifier timeout');
  },
};

describe('screenToolOutput (fail-open seam shell)', () => {
  it('given no classifier, should pass the text through unchanged (seam disabled)', async () => {
    expect(await screenToolOutput({ text: 'hi' })).toBe('hi');
  });

  it('given a clean verdict, should pass the text through unchanged', async () => {
    expect(await screenToolOutput({ text: 'hi', classifier: cleaner })).toBe('hi');
  });

  it('given a flagged verdict, should annotate AND fire the audit hook (no control-flow change)', async () => {
    const flagged: InjectionVerdict[] = [];
    const out = await screenToolOutput({
      text: 'evil body',
      classifier: flagger,
      onFlagged: (v) => flagged.push(v),
    });
    expect(out.toLowerCase()).toContain('untrusted');
    expect(out).toContain('evil body');
    expect(flagged).toHaveLength(1);
  });

  it('given the classifier throws/times out, should FAIL OPEN (original text) and log, never throw', async () => {
    const errors: unknown[] = [];
    const out = await screenToolOutput({
      text: 'original',
      classifier: thrower,
      onError: (e) => errors.push(e),
    });
    expect(out).toBe('original');
    expect(errors).toHaveLength(1);
  });

  it('should NEVER block: a flagged result still returns the (annotated) content, not an empty/blocked value', async () => {
    const out = await screenToolOutput({ text: 'payload', classifier: flagger });
    expect(out).toContain('payload');
  });
});
