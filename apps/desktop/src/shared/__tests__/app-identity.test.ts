import { describe, it, expect } from 'vitest';
import { APP_VARIANTS, resolveAppIdentity, type AppIdentity } from '../app-identity';

describe('resolveAppIdentity', () => {
  it('returns the PageSpace identity for undefined, null and empty input', () => {
    for (const input of [undefined, null, '']) {
      expect(resolveAppIdentity(input).variant).toBe('pagespace');
    }
  });

  it('returns the PageSpace identity for an unrecognized variant', () => {
    expect(resolveAppIdentity('bogus').variant).toBe('pagespace');
  });

  it('returns each declared variant by name', () => {
    for (const variant of APP_VARIANTS) {
      expect(resolveAppIdentity(variant).variant).toBe(variant);
    }
  });

  it('gives PageSpace the existing appId, product name, scheme and start path', () => {
    const identity = resolveAppIdentity('pagespace');
    expect(identity.appId).toBe('com.pagespace.app');
    expect(identity.productName).toBe('PageSpace');
    expect(identity.protocolScheme).toBe('pagespace');
    expect(identity.startPath).toBe('/dashboard');
  });

  it('points the coder identity at the Agents console under its own scheme', () => {
    const identity = resolveAppIdentity('coder');
    expect(identity.appId).toBe('com.pagespace.coder');
    expect(identity.productName).toBe('PageSpace Coder');
    expect(identity.protocolScheme).toBe('pagespace-coder');
    expect(identity.startPath).toBe('/dashboard/agents');
  });

  it('derives the deep-link scheme and prefix from the protocol scheme', () => {
    for (const variant of APP_VARIANTS) {
      const identity = resolveAppIdentity(variant);
      expect(identity.deepLinkScheme).toBe(`${identity.protocolScheme}:`);
      expect(identity.deepLinkPrefix).toBe(`${identity.protocolScheme}://`);
      // The scheme must be what `new URL(...).protocol` yields, since that is
      // what `classifyNavigation` compares it against.
      expect(new URL(`${identity.deepLinkPrefix}auth-exchange`).protocol).toBe(identity.deepLinkScheme);
    }
  });

  it('starts every variant at an absolute path on the app origin', () => {
    for (const variant of APP_VARIANTS) {
      const identity = resolveAppIdentity(variant);
      expect(identity.startPath.startsWith('/')).toBe(true);
      expect(new URL(`https://pagespace.ai${identity.startPath}`).origin).toBe('https://pagespace.ai');
    }
  });

  it('freezes identities so a caller cannot mutate one app into the other', () => {
    const identity = resolveAppIdentity('coder') as { startPath: string };
    expect(() => {
      identity.startPath = '/dashboard';
    }).toThrow();
    expect(resolveAppIdentity('coder').startPath).toBe('/dashboard/agents');
  });

  // The collision check: every one of these fields is what keeps the two apps
  // apart on disk or in the OS. A copy-pasted variant that shares any of them
  // silently merges the two apps' userData, keychain entries or deep links.
  it.each<keyof AppIdentity>(['appId', 'productName', 'protocolScheme', 'iconDir'])(
    'gives every variant a distinct %s',
    (field) => {
      const values = APP_VARIANTS.map((variant) => resolveAppIdentity(variant)[field]);
      expect(new Set(values).size).toBe(APP_VARIANTS.length);
    },
  );
});
