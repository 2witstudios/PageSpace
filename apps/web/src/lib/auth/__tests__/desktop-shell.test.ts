import { describe, it, expect } from 'vitest';
import {
  DESKTOP_SHELLS,
  desktopDeepLink,
  desktopShellScheme,
  parseDesktopShell,
} from '../desktop-shell';

describe('parseDesktopShell', () => {
  it('accepts every known shell', () => {
    for (const shell of DESKTOP_SHELLS) {
      expect(parseDesktopShell(shell)).toBe(shell);
    }
  });

  it('rejects anything else', () => {
    for (const value of [undefined, null, '', 'web', 'ios', 'PAGESPACE', 42, {}, ['coder']]) {
      expect(parseDesktopShell(value)).toBeUndefined();
    }
  });
});

describe('desktopShellScheme', () => {
  it('keeps PageSpace on its original scheme', () => {
    expect(desktopShellScheme('pagespace')).toBe('pagespace');
  });

  it('gives the coder app its own scheme', () => {
    expect(desktopShellScheme('coder')).toBe('pagespace-coder');
  });

  // Web, iOS and any desktop build predating the second app send nothing.
  // Those flows must keep working exactly as before.
  it('falls back to PageSpace for an absent or unknown shell', () => {
    for (const value of [undefined, null, '', 'nonsense', 7]) {
      expect(desktopShellScheme(value)).toBe('pagespace');
    }
  });

  it('never adopts a caller-supplied scheme', () => {
    // The whole reason this takes an enum and not a scheme string: otherwise
    // every deep-link builder becomes an arbitrary-scheme redirect.
    for (const attack of ['javascript', 'file', 'evil://x', 'pagespace-coder://x']) {
      expect(desktopShellScheme(attack)).toBe('pagespace');
    }
  });

  it('gives distinct schemes to distinct shells', () => {
    const schemes = DESKTOP_SHELLS.map(desktopShellScheme);
    expect(new Set(schemes).size).toBe(DESKTOP_SHELLS.length);
  });
});

describe('desktopDeepLink', () => {
  it('routes each host to the shell that asked for it', () => {
    expect(desktopDeepLink('pagespace', 'auth-exchange')).toBe('pagespace://auth-exchange');
    expect(desktopDeepLink('coder', 'auth-exchange')).toBe('pagespace-coder://auth-exchange');
    expect(desktopDeepLink('coder', 'auth-error')).toBe('pagespace-coder://auth-error');
    expect(desktopDeepLink('coder', 'passkey-registered')).toBe('pagespace-coder://passkey-registered');
  });

  it('produces a URL whose protocol and host the main process can dispatch on', () => {
    for (const shell of DESKTOP_SHELLS) {
      const parsed = new URL(desktopDeepLink(shell, 'auth-exchange'));
      expect(parsed.protocol).toBe(`${desktopShellScheme(shell)}:`);
      expect(parsed.host).toBe('auth-exchange');
    }
  });
});
