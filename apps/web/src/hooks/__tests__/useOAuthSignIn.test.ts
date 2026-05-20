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

  it('includes returnUrl when provided', () => {
    const body = buildOAuthSigninBody({
      platform: 'web',
      deviceId: 'dev-1',
      deviceName: 'Browser',
      returnUrl: '/s/tok-abc123',
    });
    expect(body.returnUrl).toBe('/s/tok-abc123');
  });

  it('omits returnUrl when undefined', () => {
    const body = buildOAuthSigninBody({
      platform: 'web',
      deviceId: 'dev-1',
      deviceName: 'Browser',
    });
    expect(body).not.toHaveProperty('returnUrl');
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

  it('uses returnUrl when no invite was consumed and user is not new', () => {
    expect(buildPostNativeAuthRedirect({ returnUrl: '/s/tok-abc' })).toBe('/s/tok-abc');
  });

  it('uses returnUrl over welcome redirect when user is new but has no invite', () => {
    expect(buildPostNativeAuthRedirect({ isNewUser: true, returnUrl: '/s/tok-abc' })).toBe('/s/tok-abc');
  });

  it('invite-consumed drive wins over returnUrl', () => {
    expect(buildPostNativeAuthRedirect({ invitedDriveId: 'drive-123', returnUrl: '/s/tok-abc' }))
      .toBe('/dashboard/drive-123?invited=1');
  });
});
