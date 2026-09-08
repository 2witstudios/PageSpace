/**
 * Native Apple Sign-In Bridge
 *
 * Drives the `@capgo/capacitor-social-login` Apple provider on every platform
 * that has one, and exchanges the resulting ID token with our backend for a
 * session. Formerly `ios-apple-auth.ts`.
 *
 * Today that is iOS alone. Android has no native Sign in with Apple SDK — the
 * flow there is Apple's *web* one — so `supportsNativeAuthProvider('apple')`
 * answers false on Android (`capacitor-bridge.ts`) and
 * `useOAuthSignIn.handleAppleSignIn` falls back to web OAuth. That is a missing
 * capability, not a missing branch: nothing here needs an Android row, and
 * asking the capability rather than the platform is what keeps it that way.
 */

import { getPlatform, supportsNativeAuthProvider } from './capacitor-bridge';
import { createId } from '@paralleldrive/cuid2';

export interface AppleAuthResult {
  success: boolean;
  error?: string;
  /**
   * The native path could not run here at all — no native SDK for this platform,
   * or the plugin would not load or initialize. Distinct from a failed sign-in:
   * the caller should fall back to Apple's web flow rather than leaving the user
   * with no session and a toast. On Android this is the *normal* answer.
   */
  unavailable?: boolean;
  isNewUser?: boolean;
  invitedDriveId?: string | null;
  inviteError?: string;
  returnUrl?: string;
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
  invitedDriveId?: string | null;
  inviteError?: string;
  returnUrl?: string;
  user?: AppleAuthResult['user'];
};

const APPLE_CLIENT_ID = 'ai.pagespace.ios';

/**
 * Perform native Apple Sign-In and exchange tokens with backend.
 *
 * Only runs where `supportsNativeAuthProvider('apple')` holds — iOS today; every
 * other caller gets `success: false` and falls back to web OAuth.
 */
export async function signInWithApple(options: { inviteToken?: string; returnUrl?: string } = {}): Promise<AppleAuthResult> {
  // Guard: only run where a native Apple SDK exists.
  if (!isNativeAppleAuthAvailable()) {
    return { success: false, unavailable: true, error: 'Not in a native app with Apple sign-in' };
  }

  // The real platform rather than a hardcoded 'ios'. The route already declares
  // `z.enum(['ios','android'])`, so this stays honest the day Apple ships an
  // Android SDK and `capacitor-bridge` grants the capability.
  const platform = getPlatform();

  // Loading and initializing the plugin is a separate failure from signing in
  // with it: a shell built without the plugin, or one whose native side did not
  // register, fails here — and the right answer is Apple's web flow, not an
  // error toast on a user who simply wanted to sign in.
  let SocialLogin: typeof import('@capgo/capacitor-social-login').SocialLogin;
  let Preferences: typeof import('@capacitor/preferences').Preferences;
  let PageSpaceKeychain: typeof import('./keychain-plugin').PageSpaceKeychain;
  try {
    // Dynamic imports for Capacitor plugins (only available in native context)
    ({ SocialLogin } = await import('@capgo/capacitor-social-login'));
    ({ Preferences } = await import('@capacitor/preferences'));
    ({ PageSpaceKeychain } = await import('./keychain-plugin'));

    // Initialize the plugin with Apple client ID
    await SocialLogin.initialize({
      apple: {
        clientId: APPLE_CLIENT_ID,
      },
    });
  } catch (error) {
    console.error('[Native Apple Auth] Native plugin unavailable:', error);
    return { success: false, unavailable: true, error: 'Native Apple sign-in unavailable' };
  }

  try {
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
      console.error('[Native Apple Auth] No ID token received:', result);
      throw new Error('No ID token received from Apple');
    }

    // Get or create device ID using CUID2 for consistency across codebase
    const { value: existingDeviceId } = await Preferences.get({ key: 'pagespace_device_id' });
    const deviceId = existingDeviceId || createId();
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
        platform,
        deviceId,
        deviceName: platform === 'ios' ? 'iOS App' : 'Android App',
        givenName,
        familyName,
        ...(options.inviteToken && { inviteToken: options.inviteToken }),
        ...(options.returnUrl && { returnUrl: options.returnUrl }),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[Native Apple Auth] Backend error:', response.status, errorData);
      throw new Error(errorData.error || 'Authentication failed');
    }

    const { sessionToken, csrfToken, deviceToken, isNewUser, invitedDriveId, inviteError, returnUrl, user } =
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

    console.log('[Native Apple Auth] Sign-in successful, tokens stored');

    return {
      success: true,
      isNewUser,
      user,
      ...(invitedDriveId !== undefined && { invitedDriveId }),
      ...(inviteError && { inviteError }),
      ...(returnUrl && { returnUrl }),
    };
  } catch (error) {
    console.error('[Native Apple Auth] Sign-in failed:', error);

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
 *
 * True only where the platform ships a native Sign in with Apple SDK — iOS today.
 */
export function isNativeAppleAuthAvailable(): boolean {
  return supportsNativeAuthProvider('apple');
}
