import { describe, it, expect } from 'vitest';
import {
  shouldAllowDeviceRefresh,
  getWsTokenPolicy,
  planLogoutDeviceRevocation,
  isDevicePlatform,
  WS_TOKEN_TTL_MS,
  WS_TOKEN_SCOPE,
} from '../token-lifecycle-policy';

describe('shouldAllowDeviceRefresh (L4)', () => {
  it('allows refresh when the stored deviceId exactly matches the supplied id', () => {
    expect(shouldAllowDeviceRefresh({ deviceId: 'device-123' }, 'device-123')).toEqual({ ok: true });
  });

  it('rejects when stored deviceId is the legacy "unknown" sentinel (no auto-rebind)', () => {
    expect(shouldAllowDeviceRefresh({ deviceId: 'unknown' }, 'attacker-device')).toEqual({
      ok: false,
      reason: 'unknown_stored_device',
    });
  });

  it('rejects when stored deviceId is null', () => {
    expect(shouldAllowDeviceRefresh({ deviceId: null }, 'attacker-device')).toEqual({
      ok: false,
      reason: 'unknown_stored_device',
    });
  });

  it('rejects when stored deviceId is undefined', () => {
    expect(shouldAllowDeviceRefresh({ deviceId: undefined }, 'attacker-device')).toEqual({
      ok: false,
      reason: 'unknown_stored_device',
    });
  });

  it('rejects when stored deviceId is an empty string', () => {
    expect(shouldAllowDeviceRefresh({ deviceId: '' }, 'attacker-device')).toEqual({
      ok: false,
      reason: 'unknown_stored_device',
    });
  });

  it('rejects on mismatch between a real stored deviceId and a different supplied id', () => {
    expect(shouldAllowDeviceRefresh({ deviceId: 'device-123' }, 'device-456')).toEqual({
      ok: false,
      reason: 'device_mismatch',
    });
  });

  it('rejects when the supplied deviceId is missing even though the stored id is real', () => {
    expect(shouldAllowDeviceRefresh({ deviceId: 'device-123' }, '')).toEqual({
      ok: false,
      reason: 'missing_supplied_device',
    });
    expect(shouldAllowDeviceRefresh({ deviceId: 'device-123' }, null)).toEqual({
      ok: false,
      reason: 'missing_supplied_device',
    });
  });

  it('does NOT rebind: an unknown stored id never matches by adopting the supplied id', () => {
    // Even if the supplied id is literally 'unknown', a missing binding stays a hard failure.
    expect(shouldAllowDeviceRefresh({ deviceId: 'unknown' }, 'unknown')).toEqual({
      ok: false,
      reason: 'unknown_stored_device',
    });
  });
});

describe('getWsTokenPolicy (L5)', () => {
  const policy = getWsTokenPolicy();

  it('does not mint a service-type token (so the processor service middleware rejects it)', () => {
    expect(policy.type).not.toBe('service');
    expect(policy.type).toBe('mcp');
  });

  it('does not grant the broad mcp:* wildcard scope', () => {
    expect(policy.scopes).not.toContain('mcp:*');
    expect(policy.scopes).not.toContain('*');
  });

  it('grants only the narrow websocket scope', () => {
    expect(policy.scopes).toEqual([WS_TOKEN_SCOPE]);
    expect(WS_TOKEN_SCOPE).toBe('mcp:ws');
  });

  it('uses a TTL substantially shorter than the previous 90-day lifetime', () => {
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(policy.ttlMs).toBe(WS_TOKEN_TTL_MS);
    expect(policy.ttlMs).toBeLessThan(ninetyDays);
    // "Substantially" shorter: at most a tenth of the old lifetime.
    expect(policy.ttlMs).toBeLessThanOrEqual(ninetyDays / 10);
    expect(policy.ttlMs).toBeGreaterThan(0);
  });
});

describe('planLogoutDeviceRevocation (M9)', () => {
  it('revokes by value when the client sends a raw device token', () => {
    expect(
      planLogoutDeviceRevocation({
        deviceToken: 'ps_dev_abc',
        userId: 'user-1',
        deviceId: 'device-1',
        platform: 'desktop',
      }),
    ).toEqual({ strategy: 'by-value', deviceToken: 'ps_dev_abc' });
  });

  it('trims the supplied device token value', () => {
    expect(planLogoutDeviceRevocation({ deviceToken: '  ps_dev_abc  ' })).toEqual({
      strategy: 'by-value',
      deviceToken: 'ps_dev_abc',
    });
  });

  it('revokes by device when no token value but userId + deviceId + valid platform are present', () => {
    expect(
      planLogoutDeviceRevocation({ userId: 'user-1', deviceId: 'device-1', platform: 'desktop' }),
    ).toEqual({ strategy: 'by-device', userId: 'user-1', deviceId: 'device-1', platform: 'desktop' });
  });

  it('returns none for a plain web logout with no device context', () => {
    expect(planLogoutDeviceRevocation({ userId: 'user-1' })).toEqual({ strategy: 'none' });
  });

  it('returns none when deviceId is present but platform is missing or invalid', () => {
    expect(planLogoutDeviceRevocation({ userId: 'user-1', deviceId: 'device-1' })).toEqual({
      strategy: 'none',
    });
    expect(
      planLogoutDeviceRevocation({ userId: 'user-1', deviceId: 'device-1', platform: 'bogus' }),
    ).toEqual({ strategy: 'none' });
  });

  it('returns none when userId is missing (cannot safely target by device)', () => {
    expect(
      planLogoutDeviceRevocation({ deviceId: 'device-1', platform: 'desktop' }),
    ).toEqual({ strategy: 'none' });
  });

  it('ignores empty/whitespace device token and falls through to by-device', () => {
    expect(
      planLogoutDeviceRevocation({
        deviceToken: '   ',
        userId: 'user-1',
        deviceId: 'device-1',
        platform: 'ios',
      }),
    ).toEqual({ strategy: 'by-device', userId: 'user-1', deviceId: 'device-1', platform: 'ios' });
  });
});

describe('isDevicePlatform', () => {
  it('accepts the four known platforms', () => {
    for (const p of ['web', 'desktop', 'ios', 'android']) {
      expect(isDevicePlatform(p)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isDevicePlatform('mobile')).toBe(false);
    expect(isDevicePlatform('')).toBe(false);
    expect(isDevicePlatform(undefined)).toBe(false);
    expect(isDevicePlatform(null)).toBe(false);
    expect(isDevicePlatform(42)).toBe(false);
  });
});
