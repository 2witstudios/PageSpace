import { describe, expect, it, vi } from 'vitest';
import { abortSideQuestion, createSideQuestionRequest, parseSideQuestionInput } from '../useSideQuestion';

describe('side-question client isolation', () => {
  it('mints an independent correlation id and aborting it cannot reach the main stream controller', () => {
    const main = new AbortController();
    const side = createSideQuestionRequest('conv_1', 'What does that mean?');
    expect(side.requestId).not.toEqual('');
    expect(side.body).toEqual({ conversationId: 'conv_1', question: 'What does that mean?' });
    abortSideQuestion(side.controller);
    expect(side.controller.signal.aborted).toBe(true);
    expect(main.signal.aborted).toBe(false);
  });

  it('does not use the primary send lifecycle', () => {
    const primarySend = vi.fn();
    createSideQuestionRequest('conv_1', 'Status?');
    expect(primarySend).not.toHaveBeenCalled();
  });
});

describe('parseSideQuestionInput', () => {
  it('extracts the question after /btw', () => {
    expect(parseSideQuestionInput('/btw what changed?')).toBe('what changed?');
  });

  it('returns null for a bare /btw with no question', () => {
    expect(parseSideQuestionInput('/btw')).toBeNull();
    expect(parseSideQuestionInput('  /btw   ')).toBeNull();
  });

  it('strips surrounding whitespace but keeps inner spacing', () => {
    expect(parseSideQuestionInput('  /btw   why now  ')).toBe('why now');
  });

  it('rejects text before the trigger or non-btw input', () => {
    expect(parseSideQuestionInput('hey /btw q')).toBeNull();
    expect(parseSideQuestionInput('plain text')).toBeNull();
  });

  it('captures a multi-line question whole (ChatInput routes these; the parser must not drop them)', () => {
    expect(parseSideQuestionInput('/btw first\nsecond')).toBe('first\nsecond');
    expect(parseSideQuestionInput('/btw line one\nline two\nline three')).toBe(
      'line one\nline two\nline three'
    );
  });

  it('still trims leading/trailing whitespace around a multi-line question', () => {
    expect(parseSideQuestionInput('  /btw first\nsecond\n  ')).toBe('first\nsecond');
    expect(parseSideQuestionInput('/btw\n\nonly newlines around\n\n')).toBe(
      'only newlines around'
    );
  });

  it('still rejects a bare /btw and text before the trigger when newlines are involved', () => {
    expect(parseSideQuestionInput('/btw\n')).toBeNull();
    expect(parseSideQuestionInput('/btw   \n  ')).toBeNull();
    expect(parseSideQuestionInput('hey /btw q\nmore')).toBeNull();
  });
});
