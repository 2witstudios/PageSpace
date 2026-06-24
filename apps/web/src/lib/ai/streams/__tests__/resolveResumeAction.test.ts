import { describe, it, expect } from 'vitest';
import { resolveResumeAction } from '../resolveResumeAction';

describe('resolveResumeAction', () => {
  it('native + streaming → rejoin-and-refresh', () => {
    expect(resolveResumeAction({ native: true, isStreaming: true })).toBe('rejoin-and-refresh');
  });

  it('native + not streaming → rejoin-and-refresh (fetch is dead after backgrounding regardless)', () => {
    expect(resolveResumeAction({ native: true, isStreaming: false })).toBe('rejoin-and-refresh');
  });

  it('web (non-native) + streaming → noop (must not clobber live fetch)', () => {
    expect(resolveResumeAction({ native: false, isStreaming: true })).toBe('noop');
  });

  it('web (non-native) + not streaming → refresh', () => {
    expect(resolveResumeAction({ native: false, isStreaming: false })).toBe('refresh');
  });
});
