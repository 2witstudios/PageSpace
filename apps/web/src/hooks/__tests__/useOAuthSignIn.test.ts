import { describe, it, expect } from 'vitest';
import { buildOAuthSigninBody, buildPostNativeAuthRedirect } from '../useOAuthSignIn';

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

describe('buildPostNativeAuthRedirect', () => {
  it('routes to drive-specific dashboard when an invite was consumed', () => {
    expect(buildPostNativeAuthRedirect({ invitedDriveId: 'drive-123' }))
      .toBe('/dashboard/drive-123?invited=1');
  });

  it('invite-consumed wins over isNewUser welcome', () => {
    expect(buildPostNativeAuthRedirect({ isNewUser: true, invitedDriveId: 'drive-123' }))
      .toBe('/dashboard/drive-123?invited=1');
  });

  it('routes new users to welcome when no invite', () => {
    expect(buildPostNativeAuthRedirect({ isNewUser: true }))
      .toBe('/dashboard?welcome=true');
  });

  it('falls back to /dashboard for existing users without invites', () => {
    expect(buildPostNativeAuthRedirect({})).toBe('/dashboard');
    expect(buildPostNativeAuthRedirect({ isNewUser: false })).toBe('/dashboard');
  });

  it('treats null invitedDriveId as no-invite', () => {
    expect(buildPostNativeAuthRedirect({ invitedDriveId: null })).toBe('/dashboard');
  });
});
