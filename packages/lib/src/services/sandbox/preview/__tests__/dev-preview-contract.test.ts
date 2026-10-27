import { describe, it, expect } from 'vitest';
import { DEV_PREVIEW_MESSAGE_TYPE, DEV_PREVIEW_REAUTH_EVENT, isDevPreviewReauthMessageFor } from '../dev-preview-contract';

describe('dev-preview frame contract', () => {
  it('accepts exactly a re-auth message about the given holder', () => {
    const ws = { kind: 'workspace', id: 'w' } as const;
    expect(isDevPreviewReauthMessageFor({ type: DEV_PREVIEW_MESSAGE_TYPE, event: DEV_PREVIEW_REAUTH_EVENT, holder: { kind: 'workspace', id: 'w' } }, ws)).toBe(true);
    expect(isDevPreviewReauthMessageFor({ type: DEV_PREVIEW_MESSAGE_TYPE, event: DEV_PREVIEW_REAUTH_EVENT, holder: { kind: 'env', id: 'w' } }, ws)).toBe(false);
    expect(isDevPreviewReauthMessageFor({ type: DEV_PREVIEW_MESSAGE_TYPE, event: 'other', holder: ws }, ws)).toBe(false);
    expect(isDevPreviewReauthMessageFor({ type: 'x', event: DEV_PREVIEW_REAUTH_EVENT, holder: ws }, ws)).toBe(false);
    expect(isDevPreviewReauthMessageFor({ type: DEV_PREVIEW_MESSAGE_TYPE, event: DEV_PREVIEW_REAUTH_EVENT, holder: null }, ws)).toBe(false);
    expect(isDevPreviewReauthMessageFor(null, ws)).toBe(false);
    expect(isDevPreviewReauthMessageFor('str', ws)).toBe(false);
  });
});
