import { describe, it, expect } from 'vitest';
import { canResumeRecovery } from '../canResumeRecovery';

describe('canResumeRecovery', () => {
  it('given a conversation and no active editing, should allow recovery', () => {
    expect(canResumeRecovery('conv-A', false)).toBe(true);
  });

  it('given no conversation, should NOT allow recovery (nothing to rejoin)', () => {
    expect(canResumeRecovery(null, false)).toBe(false);
  });

  it('given the user is mid-edit, should NOT allow recovery (it would clobber their work)', () => {
    expect(canResumeRecovery('conv-A', true)).toBe(false);
  });

  it('should take no streaming argument at all — the regression is not expressible in the signature', () => {
    // THE BUG THIS EXISTS TO PREVENT. The gate used to be a render-time boolean folding in
    // `!isStreaming`. iOS freezes JS the moment the app backgrounds, so the value that ended up
    // gating the resume was whatever was true when the app went AWAY — i.e. streaming — and
    // recovery was disabled in exactly the case it was written for. Whether the transport survived
    // is resolveResumeAction's question, asked at fire time; it must never be baked into this gate.
    expect(canResumeRecovery.length).toBe(2);
  });
});
