import { describe, it, expect } from 'vitest';
import { buildOAuthSigninBody } from '../useOAuthSignIn';

describe('buildOAuthSigninBody', () => {
  it('serializes web device info without inviteToken', () => {
    const body = buildOAuthSigninBody({
      platform: 'web',
      deviceId: 'dev-123',
      deviceName: 'Chrome on macOS',
    });
    expect(body).toEqual({
      platform: 'web',
      deviceId: 'dev-123',
      deviceName: 'Chrome on macOS',
    });
  });

  it('includes inviteToken when provided', () => {
    const body = buildOAuthSigninBody({
      platform: 'web',
      deviceId: 'dev-123',
      deviceName: 'Chrome',
      inviteToken: 'ps_invite_abc123def456',
    });
    expect(body.inviteToken).toBe('ps_invite_abc123def456');
  });

  it('omits inviteToken when undefined', () => {
    const body = buildOAuthSigninBody({
      platform: 'desktop',
      deviceId: 'dev-1',
      deviceName: 'My Mac',
    });
    expect(body).not.toHaveProperty('inviteToken');
  });

  it('omits inviteToken when empty string', () => {
    const body = buildOAuthSigninBody({
      platform: 'web',
      deviceId: 'dev-1',
      deviceName: 'Browser',
      inviteToken: '',
    });
    expect(body).not.toHaveProperty('inviteToken');
  });
});
