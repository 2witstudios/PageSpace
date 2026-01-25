import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { getSessionToken } from './auth-bridge';

type DeepLinkHandler = (url: string) => void;

let deepLinkHandler: DeepLinkHandler | null = null;

/**
 * Set up app lifecycle event handlers.
 * Handles app state changes, deep links, and splash screen.
 */
export function setupAppLifecycle(): void {
  // Handle app state changes (foreground/background)
  App.addListener('appStateChange', async ({ isActive }) => {
    if (isActive) {
      // App resumed from background - validate session
      await checkSessionValidity();
    }
  });

  // Handle deep links (OAuth callbacks, universal links)
  App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
    handleDeepLink(event.url);
  });

  // Hide splash screen after web app loads
  if (typeof window !== 'undefined') {
    window.addEventListener('load', async () => {
      // Small delay to ensure web app has rendered
      setTimeout(async () => {
        await SplashScreen.hide({ fadeOutDuration: 300 });
      }, 100);
    });
  }
}

/**
 * Check if the current session is still valid.
 * Called when app resumes from background.
 */
async function checkSessionValidity(): Promise<void> {
  const token = await getSessionToken();
  if (!token) {
    // No session - user needs to log in
    return;
  }

  // Session exists - web app will handle validation on next API call
  // Server returns 401 for invalid tokens, triggering re-auth
}

/**
 * Handle incoming deep links.
 * Routes OAuth callbacks and universal links to appropriate handlers.
 */
function handleDeepLink(url: string): void {
  console.log('[Lifecycle] Deep link received:', url);

  // Parse the URL to determine action
  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname;

  // OAuth callback handling
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
