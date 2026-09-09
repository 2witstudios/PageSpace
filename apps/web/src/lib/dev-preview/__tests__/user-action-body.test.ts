/**
 * One parser for both action routes, so "well-formed" cannot drift between
 * them. The echoed port and instance are security-relevant: they bind a
 * click to the exact thing that was rendered.
 */
import { describe, it, expect } from 'vitest';
import { readDevPreviewUserAction } from '../user-action-body';

describe('readDevPreviewUserAction', () => {
  it('reads the bare actions', () => {
    expect(readDevPreviewUserAction({ action: 'stop' })).toEqual({ kind: 'stop' });
    expect(readDevPreviewUserAction({ action: 'resume' })).toEqual({ kind: 'resume' });
  });

  it('reads approve AND select with the same echoed fields, keeping them distinct', () => {
    // Same fields, different assertion: approve agrees to what detection
    // found, select names a port by hand. The store treats them differently,
    // so the parser must not collapse them.
    expect(readDevPreviewUserAction({ action: 'approve', port: 9000, spriteInstanceId: 'inst' })).toEqual({ kind: 'approve', port: 9000, spriteInstanceId: 'inst' });
    expect(readDevPreviewUserAction({ action: 'select', port: 3000, spriteInstanceId: 'inst' })).toEqual({ kind: 'select', port: 3000, spriteInstanceId: 'inst' });
  });

  it('refuses a select with no port, a bad port, or no instance — the echo is the binding', () => {
    expect(readDevPreviewUserAction({ action: 'select', spriteInstanceId: 'inst' })).toBeNull();
    expect(readDevPreviewUserAction({ action: 'select', port: 70000, spriteInstanceId: 'inst' })).toBeNull();
    expect(readDevPreviewUserAction({ action: 'select', port: 3000 })).toBeNull();
    expect(readDevPreviewUserAction({ action: 'select', port: 3000, spriteInstanceId: '' })).toBeNull();
  });

  it('refuses anything else', () => {
    expect(readDevPreviewUserAction(null)).toBeNull();
    expect(readDevPreviewUserAction({ action: 'preview', port: 3000, spriteInstanceId: 'inst' })).toBeNull();
    expect(readDevPreviewUserAction('select')).toBeNull();
  });
});
