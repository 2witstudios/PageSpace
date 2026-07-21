import { describe, it, expect } from 'vitest';
import { isElectronShell } from '../native-shell';

// The Electron desktop shell's real User-Agent: Chromium's UA with the app
// name and an `Electron/<version>` product token appended.
const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PageSpace/1.0.23 Chrome/130.0.6723.137 Electron/33.3.1 Safari/537.36';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.137 Safari/537.36';

// The iOS shell is a WKWebView — no Electron token. It must never be detected
// as the Electron shell, or it would lose its own /dashboard rewrite handling.
const IOS_SHELL_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

describe('isElectronShell', () => {
  it('detects the Electron desktop shell by its Electron/ product token', () => {
    expect(isElectronShell(ELECTRON_UA)).toBe(true);
  });

  it('returns false for a regular browser UA', () => {
    expect(isElectronShell(BROWSER_UA)).toBe(false);
  });

  it('returns false for the iOS/Capacitor shell UA', () => {
    expect(isElectronShell(IOS_SHELL_UA)).toBe(false);
  });

  it('returns false for an empty UA', () => {
    expect(isElectronShell('')).toBe(false);
  });

  it('returns false for a missing UA (null)', () => {
    expect(isElectronShell(null)).toBe(false);
  });

  it('returns false for a missing UA (undefined)', () => {
    expect(isElectronShell(undefined)).toBe(false);
  });

  it('does not match the bare word Electron without the product-token slash', () => {
    expect(isElectronShell('Mozilla/5.0 ElectronFanClub')).toBe(false);
  });
});
