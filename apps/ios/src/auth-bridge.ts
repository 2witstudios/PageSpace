import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Preferences } from '@capacitor/preferences';

const AUTH_KEY = 'pagespace_session';
const DEVICE_ID_KEY = 'pagespace_device_id';
const CSRF_KEY = 'pagespace_csrf';
const MIGRATED_KEY = 'pagespace_keychain_migrated';

export interface StoredAuthSession {
  /** Opaque session token (ps_sess_*) for authentication */
  sessionToken: string;
  /** CSRF token for form submissions */
  csrfToken?: string | null;
  /** Device identifier for this installation */
  deviceId?: string | null;
}

let migrationComplete = false;

/**
 * Ensure secure storage is initialized with correct settings.
 * Disables iCloud sync so tokens stay on-device only.
 */
async function initSecureStorage(): Promise<void> {
  await SecureStorage.setSynchronize(false);
}

/**
 * Migrate any existing session data from NSUserDefaults to Keychain.
 * This is a one-time migration that runs on first access after update.
 * Includes error handling to prevent crashes if Keychain access fails.
 */
async function ensureMigrated(): Promise<void> {
  if (migrationComplete) return;

  const { value: migrated } = await Preferences.get({ key: MIGRATED_KEY });
  if (migrated === 'true') {
    migrationComplete = true;
    return;
  }

  try {
    await initSecureStorage();

    // Migrate session from NSUserDefaults to Keychain
    const { value: legacySession } = await Preferences.get({ key: AUTH_KEY });
    if (legacySession) {
      await SecureStorage.set(AUTH_KEY, legacySession, false, false);
      await Preferences.remove({ key: AUTH_KEY });
      console.log('[PageSpace iOS] Migrated session to Keychain');
    }

    // Migrate CSRF token from NSUserDefaults to Keychain
    const { value: legacyCsrf } = await Preferences.get({ key: CSRF_KEY });
    if (legacyCsrf) {
      await SecureStorage.set(CSRF_KEY, legacyCsrf, false, false);
      await Preferences.remove({ key: CSRF_KEY });
      console.log('[PageSpace iOS] Migrated CSRF token to Keychain');
    }

    await Preferences.set({ key: MIGRATED_KEY, value: 'true' });
    migrationComplete = true;
    console.log('[PageSpace iOS] Keychain migration complete');
  } catch (error) {
    // Log error but don't crash - user can still log in fresh
    console.error('[PageSpace iOS] Keychain migration failed:', error);
    // Mark as migrated to prevent retry loop
    migrationComplete = true;
  }
}

/**
 * Get or create a unique device ID for this iOS installation.
 * Used for device tracking and session management.
 * Note: Device ID is not sensitive, stored in NSUserDefaults.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
  if (value) return value;

  const deviceId =
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await Preferences.set({ key: DEVICE_ID_KEY, value: deviceId });
  return deviceId;
}

/**
 * Store the authentication session in iOS Keychain.
 * Uses encrypted storage that persists across app reinstalls.
 */
export async function storeSession(session: StoredAuthSession): Promise<void> {
  try {
    await ensureMigrated();
    // set(key, data, convertDate, sync)
    await SecureStorage.set(AUTH_KEY, JSON.stringify(session), false, false);
  } catch (error) {
    console.error('[PageSpace iOS] Failed to store session:', error);
    throw error; // Re-throw so caller knows login failed
  }
}

/**
 * Retrieve the stored session token from iOS Keychain.
 */
export async function getSession(): Promise<StoredAuthSession | null> {
  try {
    await ensureMigrated();
    // get(key, convertDate, sync)
    const value = await SecureStorage.get(AUTH_KEY, false, false);
    if (!value || typeof value !== 'string') return null;

    try {
      return JSON.parse(value) as StoredAuthSession;
    } catch {
      await clearSession();
      return null;
    }
  } catch (error) {
    console.error('[PageSpace iOS] Failed to get session:', error);
    return null;
  }
}

/**
 * Get just the session token for API requests.
 */
export async function getSessionToken(): Promise<string | null> {
  const session = await getSession();
  return session?.sessionToken ?? null;
}

/**
 * Clear all stored session data (logout).
 * Removes tokens from Keychain but preserves device ID.
 */
export async function clearSession(): Promise<void> {
  try {
    await ensureMigrated();
    // remove(key, sync)
    await SecureStorage.remove(AUTH_KEY, false);
    await SecureStorage.remove(CSRF_KEY, false);
  } catch (error) {
    console.error('[PageSpace iOS] Failed to clear session:', error);
    // Don't re-throw - logout should succeed even if Keychain fails
  }
}

/**
 * Store CSRF token in iOS Keychain.
 */
export async function storeCsrfToken(token: string): Promise<void> {
  try {
    await ensureMigrated();
    await SecureStorage.set(CSRF_KEY, token, false, false);
  } catch (error) {
    console.error('[PageSpace iOS] Failed to store CSRF token:', error);
    // Don't re-throw - CSRF storage failure shouldn't break the app
  }
}

/**
 * Get stored CSRF token from iOS Keychain.
 */
export async function getCsrfToken(): Promise<string | null> {
  try {
    await ensureMigrated();
    const value = await SecureStorage.get(CSRF_KEY, false, false);
    return typeof value === 'string' ? value : null;
  } catch (error) {
    console.error('[PageSpace iOS] Failed to get CSRF token:', error);
    return null;
  }
}

/**
 * Check if user is authenticated (has valid session).
 * Note: This only checks local storage; server may still reject expired tokens.
 */
export async function isAuthenticated(): Promise<boolean> {
  const token = await getSessionToken();
  return token !== null;
}
