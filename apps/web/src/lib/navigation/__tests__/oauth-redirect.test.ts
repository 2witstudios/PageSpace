import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { isCapacitorApp, openExternalUrl } = vi.hoisted(() => ({
  isCapacitorApp: vi.fn(() => false),
  openExternalUrl: vi.fn(),
}));
vi.mock('@/lib/capacitor-bridge', () => ({ isCapacitorApp }));
vi.mock('../app-navigation', () => ({ openExternalUrl }));

import { startThirdPartyOAuth } from '../oauth-redirect';

const CONSENT = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x';

describe('startThirdPartyOAuth', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    isCapacitorApp.mockReturnValue(false);
    openExternalUrl.mockReset();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, href: 'https://pagespace.ai/settings' } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('given the web, should navigate the page to the consent screen', async () => {
    await startThirdPartyOAuth(CONSENT);
    expect(window.location.href).toBe(CONSENT);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  // Google refuses its consent screen inside an embedded web view
  // (disallowed_useragent), and the native shell has no back gesture out of it.
  it('given the native app, should open the consent screen in the system browser sheet and leave the web view where it is', async () => {
    isCapacitorApp.mockReturnValue(true);
    await startThirdPartyOAuth(CONSENT);
    expect(openExternalUrl).toHaveBeenCalledWith(CONSENT);
    expect(window.location.href).toBe('https://pagespace.ai/settings');
  });
});

describe('integration connect flows', () => {
  const SRC = join(__dirname, '../../..');
  for (const file of [
    'app/settings/integrations/google-calendar/page.tsx',
    'components/integrations/ConnectIntegrationDialog.tsx',
  ]) {
    it(`given ${file} starts an OAuth connection, should go through startThirdPartyOAuth`, () => {
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(source).toMatch(/startThirdPartyOAuth\(/);
      expect(source).not.toMatch(/window\.location\.href\s*=\s*(url|result\.url)\b/);
    });
  }
});
