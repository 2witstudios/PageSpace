import { Preferences } from '@capacitor/preferences';

const AUTH_KEY = 'pagespace_session';
const DEVICE_ID_KEY = 'pagespace_device_id';
const CSRF_KEY = 'pagespace_csrf';

export interface StoredAuthSession {
  /** Opaque session token (ps_sess_*) for authentication */
  sessionToken: string;
  /** CSRF token for form submissions */
  csrfToken?: string | null;
  /** Device identifier for this installation */
  deviceId?: string | null;
}

/**
 * Get or create a unique device ID for this iOS installation.
 * Used for device tracking and session management.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
  if (value) return value;

  const deviceId = crypto.randomUUID();
  await Preferences.set({ key: DEVICE_ID_KEY, value: deviceId });
  return deviceId;
}

/**
 * Store the authentication session securely.
 * On iOS, Preferences uses NSUserDefaults which is encrypted at rest.
 */
export async function storeSession(session: StoredAuthSession): Promise<void> {
  await Preferences.set({
    key: AUTH_KEY,
    value: JSON.stringify(session),
  });
}

/**
 * Retrieve the stored session token.
 */
export async function getSession(): Promise<StoredAuthSession | null> {
  const { value } = await Preferences.get({ key: AUTH_KEY });
  if (!value) return null;

  try {
    return JSON.parse(value) as StoredAuthSession;
  } catch {
    // Corrupted data - clear it
    await clearSession();
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
 */
export async function clearSession(): Promise<void> {
  await Preferences.remove({ key: AUTH_KEY });
  await Preferences.remove({ key: CSRF_KEY });
}

/**
 * Store CSRF token separately for quick access.
 */
export async function storeCsrfToken(token: string): Promise<void> {
  await Preferences.set({ key: CSRF_KEY, value: token });
}

/**
 * Get stored CSRF token.
 */
export async function getCsrfToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: CSRF_KEY });
  return value;
}

/**
 * Check if user is authenticated (has valid session).
 * Note: This only checks local storage; server may still reject expired tokens.
 */
export async function isAuthenticated(): Promise<boolean> {
  const token = await getSessionToken();
  return token !== null;
}
