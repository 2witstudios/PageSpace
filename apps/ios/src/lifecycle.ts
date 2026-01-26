import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { storeSession, getOrCreateDeviceId } from './auth-bridge';

type DeepLinkHandler = (url: string) => void;

let deepLinkHandler: DeepLinkHandler | null = null;

/**
 * Set up app lifecycle event handlers.
 * Handles deep links, and splash screen.
 * Note: App state changes (foreground/background) are handled by auth-fetch.ts
 * for consistent session refresh logic across platforms.
 */
export function setupAppLifecycle(): void {
  // Handle deep links (OAuth callbacks, universal links)
  App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
    handleDeepLink(event.url);
  });

  // Hide splash screen after web app loads
  if (typeof window !== 'undefined') {
    window.addEventListener('load', () => {
      // Use requestAnimationFrame to ensure first paint is complete
      requestAnimationFrame(async () => {
        await SplashScreen.hide({ fadeOutDuration: 300 });
      });
    });
  }
}

/**
 * Handle incoming deep links.
 * Routes OAuth callbacks and universal links to appropriate handlers.
 */
function handleDeepLink(url: string): void {
  console.log('[Lifecycle] Deep link received:', url);

  // Parse the URL to determine action
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    console.error('[Lifecycle] Invalid deep link URL:', url);
    // Still call custom handler with raw URL if defined
    if (deepLinkHandler) {
      deepLinkHandler(url);
    }
    return;
  }

  // Handle auth-exchange deep links (OAuth callback with exchange code)
  // URL format: pagespace://auth-exchange?code=...&provider=...
  if (parsedUrl.host === 'auth-exchange' || parsedUrl.pathname === '/auth-exchange') {
    handleAuthExchange(parsedUrl);
    return;
  }

  const path = parsedUrl.pathname;

  // OAuth callback handling (legacy path-based)
  if (path.includes('/auth/callback') || path.includes('/api/auth/callback')) {
    // Forward to custom handler if set
    if (deepLinkHandler) {
      deepLinkHandler(url);
    } else {
      // Default: let web app handle via navigation
      if (typeof window !== 'undefined') {
        window.location.href = url;
      }
    }
    return;
  }

  // Universal link to specific page
  if (deepLinkHandler) {
    deepLinkHandler(url);
  }
}

/**
 * Handle OAuth auth-exchange deep links.
 * Exchanges the one-time code for session tokens and stores them in Keychain.
 */
async function handleAuthExchange(url: URL): Promise<void> {
  const code = url.searchParams.get('code');
  const isNewUser = url.searchParams.get('isNewUser') === 'true';

  if (!code) {
    console.error('[Auth] Missing exchange code in deep link');
    if (typeof window !== 'undefined') {
      window.location.href = '/auth/signin?error=missing_code';
    }
    return;
  }

  console.log('[Auth] Exchanging code for tokens...');

  try {
    // Get the API base URL from the current page or use production URL
    const baseUrl = typeof window !== 'undefined' && window.location.origin
      ? window.location.origin
      : 'https://pagespace.ai';

    // Exchange code for tokens via the desktop exchange endpoint (platform-agnostic)
    const response = await fetch(`${baseUrl}/api/auth/desktop/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[Auth] Exchange failed:', response.status, errorData);
      throw new Error(`Exchange failed: ${response.status}`);
    }

    const { sessionToken, csrfToken, deviceToken } = await response.json();

    if (!sessionToken) {
      throw new Error('No session token received from exchange');
    }

    // Get device ID for storage
    const deviceId = await getOrCreateDeviceId();

    // Store tokens in iOS Keychain
    await storeSession({
      sessionToken,
      csrfToken: csrfToken || null,
      deviceId,
      deviceToken: deviceToken || null,
    });

    console.log('[Auth] Tokens stored successfully, navigating to app');

    // Navigate to the app
    if (typeof window !== 'undefined') {
      const destination = isNewUser ? '/dashboard?welcome=true' : '/dashboard';
      window.location.href = destination;
    }
  } catch (error) {
    console.error('[Auth] Token exchange failed:', error);
    if (typeof window !== 'undefined') {
      window.location.href = '/auth/signin?error=exchange_failed';
    }
  }
}

/**
 * Register a custom deep link handler.
 * Use this to integrate with your app's routing system.
 */
export function setDeepLinkHandler(handler: DeepLinkHandler): void {
  deepLinkHandler = handler;
}

/**
 * Manually hide the splash screen.
 * Call this if you need more control over when the splash hides.
 */
export async function hideSplashScreen(): Promise<void> {
  await SplashScreen.hide({ fadeOutDuration: 300 });
}
