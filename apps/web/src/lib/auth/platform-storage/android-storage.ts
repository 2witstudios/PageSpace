import type { PlatformStorage, StoredSession } from './types';
import { createId } from '@paralleldrive/cuid2';

/**
 * Key the session JSON is stored under inside the native secure store.
 *
 * Deliberately identical to the iOS key (`ios-google-auth.ts:129`, `:183`,
 * `:220`) — the Android plugin registers under the *same* Capacitor name
 * (`PageSpaceKeychain`), so the two platforms share one contract and there is
 * no reason for the key to fork.
 */
const SESSION_KEY = 'pagespace_session';

/**
 * Key the device id is stored under in `@capacitor/preferences`.
 *
 * Must match the iOS key (`ios-storage.ts` `getDeviceId`, and
 * `ios-google-auth.ts:94`) so a device keeps a single identity across the
 * shared web bundle rather than minting a second one per platform module.
 */
const DEVICE_ID_KEY = 'pagespace_device_id';

/**
 * Wrap a native rejection in an Error that names the operation.
 *
 * The Android plugin rejects — it does not resolve with a failure flag — when
 * `EncryptedSharedPreferences.create()` threw during `load()`
 * (`PageSpaceSecureStoragePlugin.java:46-49`, surfaced by
 * `rejectIfNotInitialized` at `:52-58`). Capacitor turns that `call.reject`
 * into a rejected promise, so the only way for a broken keystore to become a
 * silent no-op is for *us* to swallow it. We don't: every path below either
 * rethrows through here or documents exactly why it cannot.
 */
function storageError(operation: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`[Android] Secure storage ${operation} failed: ${detail}`, { cause });
}

export class AndroidStorage implements PlatformStorage {
  readonly platform = 'android' as const;

  private async keychain() {
    const { PageSpaceKeychain } = await import('@/lib/keychain-plugin');
    return PageSpaceKeychain;
  }

  async getSessionToken(): Promise<string | null> {
    const session = await this.getStoredSession();
    return session?.sessionToken ?? null;
  }

  /**
   * Read the stored session.
   *
   * `null` means "there is no usable session here" — nothing stored, or stored
   * bytes we cannot parse. A *store failure* is different information and is
   * thrown, not flattened into `null`: every consumer of this method already
   * handles a rejection (`auth-fetch.ts:296-313` logs it and sends the request
   * unauthenticated; `refreshBearerSession` catches it and returns
   * `shouldLogout: false`, i.e. retry later), whereas a `null` there would be
   * read as "device token is gone" and force the user to sign in again over
   * what may be a transient keystore fault.
   */
  async getStoredSession(): Promise<StoredSession | null> {
    let raw: string | null;
    try {
      const keychain = await this.keychain();
      ({ value: raw } = await keychain.get({ key: SESSION_KEY }));
    } catch (error) {
      throw storageError('read', error);
    }

    if (!raw) return null;

    let parsed: Partial<StoredSession>;
    try {
      parsed = JSON.parse(raw) as Partial<StoredSession>;
    } catch {
      // Corrupt payload is not a store fault — treat it as "no session".
      return null;
    }

    if (typeof parsed.sessionToken !== 'string' || typeof parsed.deviceId !== 'string') {
      return null;
    }

    return {
      sessionToken: parsed.sessionToken,
      csrfToken: parsed.csrfToken ?? null,
      deviceId: parsed.deviceId,
      deviceToken: parsed.deviceToken ?? null,
    };
  }

  /**
   * Persist the session.
   *
   * Always throws on failure. This is the requirement that matters most: the
   * refresh path (`auth-fetch.ts` `refreshBearerSession`) reports
   * `success: true` on the line after this call, so a swallowed write would
   * hand every later request a token that was never stored and claim the
   * refresh worked.
   */
  async storeSession(session: StoredSession): Promise<void> {
    try {
      const keychain = await this.keychain();
      await keychain.set({ key: SESSION_KEY, value: JSON.stringify(session) });
    } catch (error) {
      throw storageError('write', error);
    }
  }

  /**
   * Clear the session.
   *
   * The one place a rejection is deliberately absorbed. `refreshBearerSession`
   * calls this on a server 401 and then returns `shouldLogout: true`; a throw
   * would escape to that method's outer catch and downgrade a definite logout
   * to `shouldLogout: false`, leaving the user in a signed-in shell holding a
   * token the server has already rejected. So we log, still dispatch
   * `auth:cleared`, and let the caller complete the logout. If the store is
   * broken there is nothing readable in it to leak anyway — the same fault
   * makes `getStoredSession` throw rather than return the stale session.
   */
  async clearSession(): Promise<void> {
    try {
      const keychain = await this.keychain();
      await keychain.remove({ key: SESSION_KEY });
    } catch (error) {
      console.error(storageError('clear', error).message);
    }
    this.dispatchAuthEvent('auth:cleared');
  }

  async getDeviceId(): Promise<string> {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
    if (value) return value;
    // CUID2 for consistency across the codebase (matches iOS and web).
    const id = createId();
    await Preferences.set({ key: DEVICE_ID_KEY, value: id });
    return id;
  }

  async getDeviceInfo() {
    return { deviceId: await this.getDeviceId(), userAgent: navigator.userAgent };
  }

  usesBearer() {
    return true;
  }

  supportsCSRF() {
    return false;
  }

  dispatchAuthEvent(event: 'auth:cleared' | 'auth:refreshed' | 'auth:expired') {
    window.dispatchEvent(new CustomEvent(event));
    console.log(`[Android] Dispatched ${event}`);
  }
}
