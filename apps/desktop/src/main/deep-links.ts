import { app, session } from 'electron';
import * as path from 'path';
import { saveAuthSession, type StoredAuthSession } from './auth-storage';
import { mainWindow } from './state';
import { setCachedSession } from './state';
import { getAppUrl } from './app-url';
import { logger } from './logger';

export function setupProtocolClient(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('pagespace', process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient('pagespace');
  }
}

async function handleAuthExchange(url: string): Promise<boolean> {
  try {
    const urlObj = new URL(url);

    if (urlObj.host !== 'auth-exchange') {
      return false;
    }

    const code = urlObj.searchParams.get('code');
    const provider = urlObj.searchParams.get('provider') || 'unknown';
    const isNewUser = urlObj.searchParams.get('isNewUser') === 'true';

    if (!code) {
      logger.error('[Auth Exchange] Missing code in deep link');
      mainWindow?.webContents.send('auth-error', { error: 'Missing exchange code' });
      return true;
    }

    logger.info('[Auth Exchange] Processing OAuth exchange', { provider });

    const baseUrl = getAppUrl().replace('/dashboard', '');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/auth/desktop/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        logger.error('[Auth Exchange] Request timed out');
        mainWindow?.webContents.send('auth-error', {
          error: 'Authentication request timed out',
        });
        return true;
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Exchange failed' })) as { error?: string };
      logger.error('[Auth Exchange] Exchange failed', {
        status: response.status,
        error: errorData.error,
      });
      mainWindow?.webContents.send('auth-error', {
        error: errorData.error || 'Failed to complete authentication',
      });
      return true;
    }

    const tokens = await response.json() as Partial<{
      sessionToken: string;
      csrfToken: string;
      deviceToken: string;
    }> | null;

    if (
      typeof tokens?.sessionToken !== 'string' || !tokens.sessionToken ||
      typeof tokens?.csrfToken !== 'string' || !tokens.csrfToken ||
      typeof tokens?.deviceToken !== 'string' || !tokens.deviceToken
    ) {
      logger.error('[Auth Exchange] Invalid token response', {
        hasSessionToken: !!tokens?.sessionToken,
        hasCsrfToken: !!tokens?.csrfToken,
        hasDeviceToken: !!tokens?.deviceToken,
      });
      mainWindow?.webContents.send('auth-error', {
        error: 'Invalid authentication response from server',
      });
      return true;
    }

    const sessionData: StoredAuthSession = {
      sessionToken: tokens.sessionToken,
      csrfToken: tokens.csrfToken,
      deviceToken: tokens.deviceToken,
    };
    await saveAuthSession(sessionData);
    setCachedSession(sessionData);

    const appUrl = new URL(getAppUrl());
    try {
      await session.defaultSession.cookies.set({
        url: appUrl.origin,
        name: 'session',
        value: tokens.sessionToken,
        path: '/',
        httpOnly: true,
        secure: !appUrl.origin.includes('localhost') && !appUrl.origin.includes('127.0.0.1'),
        sameSite: 'strict' as const,
        expirationDate: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      });
    } catch (cookieError) {
      logger.warn('[Auth Exchange] Failed to set session cookie in BrowserWindow', { cookieError });
    }

    logger.info('[Auth Exchange] OAuth exchange successful', { provider });

    const dashboardUrl = new URL(getAppUrl());
    dashboardUrl.searchParams.set('auth', 'success');
    if (isNewUser) {
      dashboardUrl.searchParams.set('isNewUser', 'true');
    }
    mainWindow?.loadURL(dashboardUrl.toString());

    return true;
  } catch (error) {
    logger.error('[Auth Exchange] Unexpected error', { error });
    mainWindow?.webContents.send('auth-error', {
      error: 'Authentication failed unexpectedly',
    });
    return true;
  }
}

export async function handleDeepLink(url: string): Promise<void> {
  const handled = await handleAuthExchange(url);
  if (handled) {
    return;
  }

  if (mainWindow) {
    mainWindow.webContents.send('deep-link', url);
  }
}
