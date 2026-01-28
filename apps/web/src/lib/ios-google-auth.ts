/**
 * iOS Native Google Sign-In Bridge
 *
 * This module handles native Google Sign-In for iOS using the
 * @capgo/capacitor-social-login plugin. It provides a native account
 * picker experience instead of in-app browser OAuth.
 */

import { isCapacitorApp, getPlatform } from './capacitor-bridge';
import { createId } from '@paralleldrive/cuid2';

export interface GoogleAuthResult {
  success: boolean;
  error?: string;
  isNewUser?: boolean;
  user?: {
    id: string;
    name: string | null;
    email: string | null;
    image?: string | null;
  };
}

type GoogleNativeAuthResponse = {
  sessionToken?: string;
  csrfToken?: string | null;
  deviceToken?: string;
  isNewUser?: boolean;
  user?: GoogleAuthResult['user'];
};

type StoredSession = {
  sessionToken: string;
  csrfToken: string | null;
  deviceId: string;
  deviceToken: string | null;
};

const IOS_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID;

/**
 * Perform native Google Sign-In and exchange tokens with backend.
 * Only works when running in the iOS Capacitor app.
 */
export async function signInWithGoogle(): Promise<GoogleAuthResult> {
  // Guard: only run on iOS native app
  if (!isCapacitorApp() || getPlatform() !== 'ios') {
    return { success: false, error: 'Not in iOS app' };
  }

  // Validate iOS client ID is configured
  if (!IOS_CLIENT_ID) {
    console.error('[iOS Google Auth] Missing NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID');
    return { success: false, error: 'iOS Google Sign-In not configured' };
  }

  try {
    // Dynamic imports for Capacitor plugins (only available in native context)
    const { SocialLogin } = await import('@capgo/capacitor-social-login');
    const { Preferences } = await import('@capacitor/preferences');
    const { PageSpaceKeychain } = await import('./keychain-plugin');

    // Initialize the plugin with iOS client ID
    await SocialLogin.initialize({
      google: {
        iOSClientId: IOS_CLIENT_ID,
      },
    });

    // Trigger native Google Sign-In (shows native account picker)
    const result = await SocialLogin.login({
      provider: 'google',
      options: {
        scopes: ['email', 'profile'],
        forcePrompt: true, // Always show account picker, don't auto-select cached account
      },
    });

    // Verify we got an online response with ID token
    // The result can be 'online' (with idToken) or 'offline' (with serverAuthCode)
    const googleResult = result.result;
    if (googleResult.responseType !== 'online' || !googleResult.idToken) {
      console.error('[iOS Google Auth] No ID token received:', result);
      throw new Error('No ID token received from Google');
    }

    // Get or create device ID using CUID2 for consistency across codebase
    const { value: existingDeviceId } = await Preferences.get({ key: 'pagespace_device_id' });
    const deviceId = existingDeviceId || createId();
    if (!existingDeviceId) {
      await Preferences.set({ key: 'pagespace_device_id', value: deviceId });
    }

    // Exchange Google ID token with our backend
    const response = await fetch('/api/auth/google/native', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken: googleResult.idToken,
        platform: 'ios',
        deviceId,
        deviceName: 'iOS App',
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[iOS Google Auth] Backend error:', response.status, errorData);
      throw new Error(errorData.error || 'Authentication failed');
    }

    const { sessionToken, csrfToken, deviceToken, isNewUser, user } =
      (await response.json()) as GoogleNativeAuthResponse;

    if (!sessionToken) {
      throw new Error('No session token received from server');
    }

    // Store tokens in iOS Keychain via PageSpaceKeychain plugin
    await PageSpaceKeychain.set({
      key: 'pagespace_session',
      value: JSON.stringify({
        sessionToken,
        csrfToken: csrfToken || null,
        deviceId,
        deviceToken: deviceToken || null,
      }),
    });

    console.log('[iOS Google Auth] Sign-in successful, tokens stored');

    return { success: true, isNewUser, user };
  } catch (error) {
    console.error('[iOS Google Auth] Sign-in failed:', error);

    // Handle specific error cases
    if (error instanceof Error) {
      // User cancelled the sign-in
      if (error.message.includes('cancel') || error.message.includes('Cancel')) {
        return { success: false, error: 'Sign-in cancelled' };
      }
      return { success: false, error: error.message };
    }

    return { success: false, error: 'Sign-in failed' };
  }
}

/**
 * Check if native Google Sign-In is available.
 * Returns true only when running in iOS Capacitor app.
 */
export function isNativeGoogleAuthAvailable(): boolean {
  return isCapacitorApp() && getPlatform() === 'ios';
}

/**
 * Retrieve stored session from iOS Keychain.
 * Returns the full session object including sessionToken, csrfToken, and deviceId.
 */
export async function getStoredSession(): Promise<StoredSession | null> {
  if (!isCapacitorApp() || getPlatform() !== 'ios') {
    return null;
  }

  try {
    const { PageSpaceKeychain } = await import('./keychain-plugin');
    const { value } = await PageSpaceKeychain.get({ key: 'pagespace_session' });
    if (!value) return null;

    const parsed = JSON.parse(value) as Partial<StoredSession>;
    if (typeof parsed.sessionToken !== 'string' || typeof parsed.deviceId !== 'string') {
      return null;
    }
    return {
      sessionToken: parsed.sessionToken,
      csrfToken: parsed.csrfToken ?? null,
      deviceId: parsed.deviceId,
      deviceToken: parsed.deviceToken ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Get session token from iOS Keychain for API authorization.
 * Convenience wrapper that returns just the token.
 */
export async function getSessionToken(): Promise<string | null> {
  const session = await getStoredSession();
  return session?.sessionToken ?? null;
}

/**
 * Clear stored session from iOS Keychain on logout.
 */
export async function clearStoredSession(): Promise<void> {
  if (!isCapacitorApp() || getPlatform() !== 'ios') {
    return;
  }

  try {
    const { PageSpaceKeychain } = await import('./keychain-plugin');
    await PageSpaceKeychain.remove({ key: 'pagespace_session' });
    await PageSpaceKeychain.remove({ key: 'pagespace_csrf' });
  } catch (error) {
    console.error('[iOS Google Auth] Failed to clear session:', error);
  }
}
