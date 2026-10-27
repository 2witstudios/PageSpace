import { describe, it, expect } from 'vitest';
import { isValidPartFrame } from '../isValidPartFrame';

describe('isValidPartFrame', () => {
  it('given a text part with a non-empty type, should return true', () => {
    expect(isValidPartFrame({ type: 'text', text: 'hi' })).toBe(true);
  });

  it('given a tool part with type and toolCallId, should return true', () => {
    expect(
      isValidPartFrame({
        type: 'tool-list_pages',
        toolCallId: 'tc1',
        state: 'output-available',
        input: {},
        output: {},
      }),
    ).toBe(true);
  });

  it('given null, should return false', () => {
    expect(isValidPartFrame(null)).toBe(false);
  });

  it('given undefined, should return false', () => {
    expect(isValidPartFrame(undefined)).toBe(false);
  });

  it('given a non-object primitive, should return false', () => {
    expect(isValidPartFrame('text')).toBe(false);
    expect(isValidPartFrame(42)).toBe(false);
    expect(isValidPartFrame(true)).toBe(false);
  });

  it('given an object with no type field, should return false', () => {
    expect(isValidPartFrame({})).toBe(false);
  });

  it('given an object whose type is not a string, should return false', () => {
    expect(isValidPartFrame({ type: 5 })).toBe(false);
  });

  it('given an object whose type is an empty string, should return false', () => {
    expect(isValidPartFrame({ type: '' })).toBe(false);
  });

  it('given a tool-prefixed part missing toolCallId, should return false (toolCallId is the idempotency key for appendPart)', () => {
    expect(isValidPartFrame({ type: 'tool-list_pages', state: 'input-available' })).toBe(false);
  });

  it('given a tool-prefixed part with a non-string toolCallId, should return false', () => {
    expect(isValidPartFrame({ type: 'tool-list_pages', toolCallId: 42 })).toBe(false);
  });
});
