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

// Dev mode: no electron-builder productName injection, so app.getName()
// falls back to package.json name — the UA token is desktop/<version>.
const DEV_SHELL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) desktop/1.0.3 Chrome/130.0.6723.137 Electron/33.3.1 Safari/537.36';

// PageSpace Coder is the second app built from the same Electron shell.
// Copied verbatim from a request made by a real packaged build — note
// "PageSpaceCoder", with no space: Chromium strips spaces out of the app name
// when it assembles the UA, so the productName spelling "PageSpace Coder/"
// never appears on the wire. And "PageSpaceCoder/" does not contain
// "PageSpace/", so the app needs its own allowlist entry; without one the
// middleware bounces every cookie-less Coder navigation to signin.
const CODER_SHELL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PageSpaceCoder/1.0.3 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36';

// A third-party Electron-based browser or app webview visiting pagespace.ai:
// carries Electron/ but not our app token. It must keep the normal signin
// redirect rather than being handed the empty dashboard shell.
const FOREIGN_ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SomeBrowser/2.4.1 Chrome/130.0.6723.137 Electron/33.3.1 Safari/537.36';

describe('isElectronShell', () => {
  it('detects the coder shell, whose token contains neither a space nor "PageSpace/"', () => {
    expect(CODER_SHELL_UA.includes('PageSpace/')).toBe(false);
    expect(CODER_SHELL_UA.includes('PageSpace Coder/')).toBe(false);
    expect(isElectronShell(CODER_SHELL_UA)).toBe(true);
  });

  it('does not accept the spaced productName spelling, which never reaches the wire', () => {
    const spaced = CODER_SHELL_UA.replace('PageSpaceCoder/', 'PageSpace Coder/');
    expect(isElectronShell(spaced)).toBe(false);
  });

  it('detects the packaged shell by Electron/ plus the PageSpace/ productName token', () => {
    expect(isElectronShell(ELECTRON_UA)).toBe(true);
  });

  it('detects the dev shell by Electron/ plus the desktop/ package-name token', () => {
    expect(isElectronShell(DEV_SHELL_UA)).toBe(true);
  });

  it('returns false for a third-party Electron app without the PageSpace app token', () => {
    expect(isElectronShell(FOREIGN_ELECTRON_UA)).toBe(false);
  });

  it('returns false for an app token without the Electron/ token', () => {
    expect(isElectronShell('Mozilla/5.0 PageSpace/1.0.23 Chrome/130.0.0.0 Safari/537.36')).toBe(false);
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
