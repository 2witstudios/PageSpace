import { describe, it, expect } from 'vitest';

import {
  buildPasskeyExternalUrl,
  buildPasskeyExchangeDeepLink,
  parsePasskeyExternalParams,
  buildPasskeyRegisterExternalUrl,
  parsePasskeyRegisterExternalParams,
  buildPasskeyRegisteredDeepLink,
} from '../passkeyExternal';

describe('buildPasskeyExternalUrl', () => {
  it('builds an /auth/passkey-external URL on the given origin with device fields', () => {
    const url = buildPasskeyExternalUrl('https://pagespace.ai', {
      deviceId: 'device-123',
      deviceName: 'Jono Mac',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://pagespace.ai');
    expect(parsed.pathname).toBe('/auth/passkey-external');
    expect(parsed.searchParams.get('deviceId')).toBe('device-123');
    expect(parsed.searchParams.get('deviceName')).toBe('Jono Mac');
  });

  it('encodes device names that contain special characters', () => {
    const url = buildPasskeyExternalUrl('http://localhost:3000', {
      deviceId: 'd',
      deviceName: 'My Mac / Work',
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get('deviceName')).toBe('My Mac / Work');
  });

  it('preserves an http://localhost origin for development builds', () => {
    const url = buildPasskeyExternalUrl('http://localhost:3000', {
      deviceId: 'd',
      deviceName: 'n',
    });

    expect(url.startsWith('http://localhost:3000/auth/passkey-external')).toBe(true);
  });
});

describe('buildPasskeyExchangeDeepLink', () => {
  it('builds a pagespace://auth-exchange deep link with code and passkey provider', () => {
    const url = buildPasskeyExchangeDeepLink('abc123');

    expect(url).toContain('pagespace://auth-exchange');
    expect(url).toContain('code=abc123');
    expect(url).toContain('provider=passkey');
  });

  it('uri-encodes exchange codes that contain reserved characters', () => {
    const url = buildPasskeyExchangeDeepLink('a+b/c=');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('code')).toBe('a+b/c=');
    expect(parsed.searchParams.get('provider')).toBe('passkey');
  });
});

describe('parsePasskeyExternalParams', () => {
  it('returns deviceId and deviceName when both are present', () => {
    expect(parsePasskeyExternalParams('?deviceId=d-1&deviceName=Mac')).toEqual({
      deviceId: 'd-1',
      deviceName: 'Mac',
    });
  });

  it('returns null when deviceId is missing', () => {
    expect(parsePasskeyExternalParams('?deviceName=Mac')).toBeNull();
  });

  it('returns null when deviceName is missing', () => {
    expect(parsePasskeyExternalParams('?deviceId=d-1')).toBeNull();
  });

  it('returns null for empty search string', () => {
    expect(parsePasskeyExternalParams('')).toBeNull();
  });
});

describe('buildPasskeyRegisterExternalUrl', () => {
  it('builds an /auth/passkey-register-external URL with all three fields', () => {
    const url = buildPasskeyRegisterExternalUrl('https://pagespace.ai', {
      deviceId: 'device-123',
      deviceName: 'Jono Mac',
      handoffToken: 'handoff-abc',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://pagespace.ai');
    expect(parsed.pathname).toBe('/auth/passkey-register-external');
    expect(parsed.searchParams.get('deviceId')).toBe('device-123');
    expect(parsed.searchParams.get('deviceName')).toBe('Jono Mac');
    expect(parsed.searchParams.get('handoffToken')).toBe('handoff-abc');
  });

  it('encodes device names with spaces and special characters', () => {
    const url = buildPasskeyRegisterExternalUrl('http://localhost:3000', {
      deviceId: 'd',
      deviceName: "Jono's MacBook Pro",
      handoffToken: 't',
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get('deviceName')).toBe("Jono's MacBook Pro");
  });

  it('round-trips build → parse for a device name with special characters', () => {
    const fields = {
      deviceId: 'device-xyz',
      deviceName: "Jono's MacBook Pro / Work",
      handoffToken: 'token+slash/equals=',
    };
    const url = buildPasskeyRegisterExternalUrl('https://pagespace.ai', fields);
    const parsed = new URL(url);
    const recovered = parsePasskeyRegisterExternalParams(parsed.search);
    expect(recovered).toEqual(fields);
  });

  it('preserves an http://localhost origin for development builds', () => {
    const url = buildPasskeyRegisterExternalUrl('http://localhost:3000', {
      deviceId: 'd',
      deviceName: 'n',
      handoffToken: 't',
    });

    expect(
      url.startsWith('http://localhost:3000/auth/passkey-register-external'),
    ).toBe(true);
  });
});

describe('parsePasskeyRegisterExternalParams', () => {
  it('returns deviceId, deviceName, and handoffToken when all are present', () => {
    expect(
      parsePasskeyRegisterExternalParams(
        '?deviceId=d-1&deviceName=Mac&handoffToken=h-1',
      ),
    ).toEqual({
      deviceId: 'd-1',
      deviceName: 'Mac',
      handoffToken: 'h-1',
    });
  });

  it('returns null when deviceId is missing', () => {
    expect(
      parsePasskeyRegisterExternalParams('?deviceName=Mac&handoffToken=h-1'),
    ).toBeNull();
  });

  it('returns null when deviceName is missing', () => {
    expect(
      parsePasskeyRegisterExternalParams('?deviceId=d-1&handoffToken=h-1'),
    ).toBeNull();
  });

  it('returns null when handoffToken is missing', () => {
    expect(
      parsePasskeyRegisterExternalParams('?deviceId=d-1&deviceName=Mac'),
    ).toBeNull();
  });

  it('returns null for an empty search string', () => {
    expect(parsePasskeyRegisterExternalParams('')).toBeNull();
  });
});

describe('buildPasskeyRegisteredDeepLink', () => {
  it('returns exactly pagespace://passkey-registered with no params or trailing punctuation', () => {
    expect(buildPasskeyRegisteredDeepLink()).toBe('pagespace://passkey-registered');
  });
});
