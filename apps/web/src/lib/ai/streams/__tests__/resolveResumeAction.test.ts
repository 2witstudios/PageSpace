import { describe, it, expect } from 'vitest';
import { resolveResumeAction } from '../resolveResumeAction';

describe('resolveResumeAction', () => {
  it('native + streaming → rejoin-and-refresh', () => {
    expect(resolveResumeAction({ native: true, isStreaming: true })).toBe('rejoin-and-refresh');
  });

  it('web (non-native) + streaming → noop (must not clobber live fetch)', () => {
    expect(resolveResumeAction({ native: false, isStreaming: true })).toBe('noop');
  });

  it('native + not streaming → refresh', () => {
    expect(resolveResumeAction({ native: true, isStreaming: false })).toBe('refresh');
  });

  it('web (non-native) + not streaming → refresh', () => {
    expect(resolveResumeAction({ native: false, isStreaming: false })).toBe('refresh');
  });
});
