/**
 * Native Google Sign-In Bridge
 *
 * Drives the `@capgo/capacitor-social-login` Google provider on every platform
 * that has one, and exchanges the resulting ID token with our backend for a
 * session. Formerly `ios-google-auth.ts`; the flow is identical on Android, so
 * the only per-platform knowledge is the table in {@link NATIVE_GOOGLE_CONFIG}
 * below.
 *
 * Availability is asked of `supportsNativeAuthProvider('google')` rather than
 * tested against a platform string — see `capacitor-bridge.ts`, which owns that
 * table. A platform gains this path by flipping a flag there and adding a row
 * here, with no change at the call site.
 */

import {
  getPlatform,
  hasNativeCapability,
  supportsNativeAuthProvider,
  type Platform,
} from './capacitor-bridge';
import { createId } from '@paralleldrive/cuid2';

export interface GoogleAuthResult {
  success: boolean;
  error?: string;
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

type GoogleNativeAuthResponse = {
  sessionToken?: string;
  csrfToken?: string | null;
  deviceToken?: string;
  isNewUser?: boolean;
  invitedDriveId?: string | null;
  inviteError?: string;
  returnUrl?: string;
  user?: GoogleAuthResult['user'];
};

type StoredSession = {
  sessionToken: string;
  csrfToken: string | null;
  deviceId: string;
  deviceToken: string | null;
};

/**
 * Which client id each platform's Google SDK initializes with.
 *
 * These are two *different* OAuth clients, not one value under two names. The
 * iOS SDK authenticates as the iOS client and mints an ID token with that
 * audience. The Android SDK has no client id of its own — it is configured with
 * the **web** client id (`webClientId`, the plugin's required Android field) and
 * the token it returns carries the web client as its audience. Both are already
 * in the accepted-audience list at `api/auth/google/native/route.ts:92-97`, so
 * this needs no server change.
 *
 * `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` is the same web client id Google One Tap
 * already uses (`components/auth/GoogleOneTap.tsx:208`), so Android introduces
 * no new environment variable.
 *
 * Read as whole `process.env.X` member expressions so Next.js can inline them at
 * build time; a computed lookup would resolve to undefined in the browser.
 */
const IOS_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID;
const WEB_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;

/** The subset of the plugin's `initialize({ google })` shape we set. */
interface GoogleInitOptions {
  iOSClientId?: string;
  webClientId?: string;
}

interface NativeGoogleConfig {
  /** What the plugin needs to talk to Google here, or `null` when unconfigured. */
  init: () => GoogleInitOptions | null;
  /** Message when `init()` answers null — kept per-platform so the log names the missing variable. */
  misconfigured: string;
  deviceName: string;
}

const NATIVE_GOOGLE_CONFIG: Partial<Record<Platform, NativeGoogleConfig>> = {
  ios: {
    init: () => (IOS_CLIENT_ID ? { iOSClientId: IOS_CLIENT_ID } : null),
    misconfigured: 'iOS Google Sign-In not configured',
    deviceName: 'iOS App',
  },
  android: {
    init: () => (WEB_CLIENT_ID ? { webClientId: WEB_CLIENT_ID } : null),
    misconfigured: 'Android Google Sign-In not configured',
    deviceName: 'Android App',
  },
};

/**
 * Load and initialize the native Google SDK.
 *
 * `null` means the native path cannot run here at all — the plugin is not in the
 * build, or its native side did not register. Separated from the sign-in itself
 * so that case reports a named cause instead of a raw bridge exception. It is
 * deliberately not a signal to try web OAuth instead; `useOAuthSignIn` explains
 * why there is nothing to fall back to.
 */
async function loadGoogleSdk(init: GoogleInitOptions) {
  try {
    // Dynamic imports for Capacitor plugins (only available in native context)
    const { SocialLogin } = await import('@capgo/capacitor-social-login');
    const { Preferences } = await import('@capacitor/preferences');
    const { PageSpaceKeychain } = await import('./keychain-plugin');

    await SocialLogin.initialize({ google: init });

    return { SocialLogin, Preferences, PageSpaceKeychain };
  } catch (error) {
    console.error('[Native Google Auth] Native plugin unavailable:', error);
    return null;
  }
}

/**
 * Perform native Google Sign-In and exchange tokens with the backend.
 *
 * Runs only where `isNativeGoogleAuthAvailable()` holds. A failure here is
 * reported to the user, not retried through web OAuth — see `useOAuthSignIn`.
 */
export async function signInWithGoogle(options: { inviteToken?: string; returnUrl?: string } = {}): Promise<GoogleAuthResult> {
  // Guard: only run where a native Google SDK exists.
  const platform = getPlatform();
  const config = NATIVE_GOOGLE_CONFIG[platform];
  if (!isNativeGoogleAuthAvailable() || !config) {
    return { success: false, error: 'Not in a native app with Google sign-in' };
  }

  const init = config.init();
  if (!init) {
    console.error(`[Native Google Auth] ${config.misconfigured}`);
    return { success: false, error: config.misconfigured };
  }

  const sdk = await loadGoogleSdk(init);
  if (!sdk) {
    return { success: false, error: 'Native Google sign-in unavailable' };
  }
  const { SocialLogin, Preferences, PageSpaceKeychain } = sdk;

  try {
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
      console.error('[Native Google Auth] No ID token received:', result);
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
        // The real platform, not a hardcoded 'ios'. The route already declares
        // `z.enum(['ios','android'])` and records it on the device row, which is
        // what `device/refresh` later branches on.
        platform,
        deviceId,
        deviceName: config.deviceName,
        ...(options.inviteToken && { inviteToken: options.inviteToken }),
        ...(options.returnUrl && { returnUrl: options.returnUrl }),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[Native Google Auth] Backend error:', response.status, errorData);
      throw new Error(errorData.error || 'Authentication failed');
    }

    const { sessionToken, csrfToken, deviceToken, isNewUser, invitedDriveId, inviteError, returnUrl, user } =
      (await response.json()) as GoogleNativeAuthResponse;

    if (!sessionToken) {
      throw new Error('No session token received from server');
    }

    // Store tokens in the platform secure store via the PageSpaceKeychain
    // plugin — the Android plugin registers under the same Capacitor name and
    // the same key, so this line is genuinely shared.
    await PageSpaceKeychain.set({
      key: 'pagespace_session',
      value: JSON.stringify({
        sessionToken,
        csrfToken: csrfToken || null,
        deviceId,
        deviceToken: deviceToken || null,
      }),
    });

    console.log('[Native Google Auth] Sign-in successful, tokens stored');

    return {
      success: true,
      isNewUser,
      user,
      ...(invitedDriveId !== undefined && { invitedDriveId }),
      ...(inviteError && { inviteError }),
      ...(returnUrl && { returnUrl }),
    };
  } catch (error) {
    console.error('[Native Google Auth] Sign-in failed:', error);

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
 *
 * True wherever the platform ships a native Google SDK — iOS and Android today.
 *
 * Both halves are required: the capability table says the platform *has* an SDK,
 * and the config table below says this module knows how to configure it. If the
 * two ever drift, the missing row makes the platform report unavailable and the
 * caller takes the web flow — rather than claiming native support and then
 * refusing every attempt.
 */
export function isNativeGoogleAuthAvailable(): boolean {
  return supportsNativeAuthProvider('google') && !!NATIVE_GOOGLE_CONFIG[getPlatform()];
}

/**
 * Retrieve the stored session from the platform secure store.
 *
 * Returns the full session object including sessionToken, csrfToken and deviceId,
 * or `null` when there is no usable session — absent, unparseable, or the wrong
 * shape. A *store fault* is different information and is thrown, matching
 * `AndroidStorage.getStoredSession` and the contract in `platform-storage/types.ts`:
 * callers read `null` as "the device token is gone" and force a re-auth
 * (`refreshBearerSession` → `shouldLogout: true`), so flattening a transient
 * Keychain failure into `null` signs the user out over a slow keystore. Every
 * caller already handles a rejection — `auth-fetch` logs it and sends the request
 * unauthenticated, `refreshBearerSession` catches it and returns
 * `shouldLogout: false` (retryable).
 */
export async function getStoredSession(): Promise<StoredSession | null> {
  if (!hasNativeCapability('secureStore')) {
    return null;
  }

  let value: string | null;
  try {
    const { PageSpaceKeychain } = await import('./keychain-plugin');
    ({ value } = await PageSpaceKeychain.get({ key: 'pagespace_session' }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[Native Auth] Secure storage read failed: ${detail}`, { cause: error });
  }

  if (!value) return null;

  // Past this point the store answered; unusable *bytes* are not a fault.
  try {
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
 * Get the session token from the platform secure store for API authorization.
 * Convenience wrapper that returns just the token.
 */
export async function getSessionToken(): Promise<string | null> {
  const session = await getStoredSession();
  return session?.sessionToken ?? null;
}

/**
 * Clear the stored session from the platform secure store on logout.
 */
export async function clearStoredSession(): Promise<void> {
  if (!hasNativeCapability('secureStore')) {
    return;
  }

  try {
    const { PageSpaceKeychain } = await import('./keychain-plugin');
    await PageSpaceKeychain.remove({ key: 'pagespace_session' });
    await PageSpaceKeychain.remove({ key: 'pagespace_csrf' });
  } catch (error) {
    console.error('[Native Auth] Failed to clear session:', error);
  }
}
