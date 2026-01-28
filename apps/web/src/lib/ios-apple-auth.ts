/**
 * iOS Native Apple Sign-In Bridge
 *
 * This module handles native Apple Sign-In for iOS using the
 * @capgo/capacitor-social-login plugin. It provides a native
 * Sign in with Apple experience.
 */

import { isCapacitorApp, getPlatform } from './capacitor-bridge';

export interface AppleAuthResult {
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

type AppleNativeAuthResponse = {
  sessionToken?: string;
  csrfToken?: string | null;
  deviceToken?: string;
  isNewUser?: boolean;
  user?: AppleAuthResult['user'];
};

type StoredSession = {
  sessionToken: string;
  csrfToken: string | null;
  deviceId: string;
  deviceToken: string | null;
};

const APPLE_CLIENT_ID = 'ai.pagespace.ios';

/**
 * Perform native Apple Sign-In and exchange tokens with backend.
 * Only works when running in the iOS Capacitor app.
 */
export async function signInWithApple(): Promise<AppleAuthResult> {
  // Guard: only run on iOS native app
  if (!isCapacitorApp() || getPlatform() !== 'ios') {
    return { success: false, error: 'Not in iOS app' };
  }

  try {
    // Dynamic imports for Capacitor plugins (only available in native context)
    const { SocialLogin } = await import('@capgo/capacitor-social-login');
    const { Preferences } = await import('@capacitor/preferences');
    const { PageSpaceKeychain } = await import('./keychain-plugin');

    // Initialize the plugin with Apple client ID
    await SocialLogin.initialize({
      apple: {
        clientId: APPLE_CLIENT_ID,
      },
    });

    // Trigger native Apple Sign-In
    const result = await SocialLogin.login({
      provider: 'apple',
      options: {
        scopes: ['email', 'name'],
      },
    });

    // Extract the result
    const appleResult = result.result;

    // Apple returns idToken in the response
    if (!appleResult.idToken) {
      console.error('[iOS Apple Auth] No ID token received:', result);
      throw new Error('No ID token received from Apple');
    }

    // Get or create device ID
    const { value: existingDeviceId } = await Preferences.get({ key: 'pagespace_device_id' });
    const deviceId = existingDeviceId || crypto.randomUUID();
    if (!existingDeviceId) {
      await Preferences.set({ key: 'pagespace_device_id', value: deviceId });
    }

    // Apple provides name only on first sign-in
    // Extract from the profile if available
    const givenName = appleResult.profile?.givenName;
    const familyName = appleResult.profile?.familyName;

    // Exchange Apple ID token with our backend
    const response = await fetch('/api/auth/apple/native', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken: appleResult.idToken,
        platform: 'ios',
        deviceId,
        deviceName: 'iOS App',
        givenName,
        familyName,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[iOS Apple Auth] Backend error:', response.status, errorData);
      throw new Error(errorData.error || 'Authentication failed');
    }

    const { sessionToken, csrfToken, deviceToken, isNewUser, user } =
      (await response.json()) as AppleNativeAuthResponse;

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

    console.log('[iOS Apple Auth] Sign-in successful, tokens stored');

    return { success: true, isNewUser, user };
  } catch (error) {
    console.error('[iOS Apple Auth] Sign-in failed:', error);

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
 * Check if native Apple Sign-In is available.
 * Returns true only when running in iOS Capacitor app.
 */
export function isNativeAppleAuthAvailable(): boolean {
  return isCapacitorApp() && getPlatform() === 'ios';
}
