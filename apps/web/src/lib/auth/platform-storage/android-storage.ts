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
 * Where the pre-native Android session lives.
 *
 * Until native sign-in lands, every Android sign-in runs the *web* flow inside
 * the WebView, and that flow writes its device token to `localStorage` —
 * `useAuth.ts` captures the `ps_device_token` cookie into `deviceToken`, and
 * `PasskeyLoginButton` writes the same key. Android read those keys through
 * `WebStorage` before this class existed. Reading only the keychain would leave
 * that token stranded: `refreshBearerSession` would see no device token and
 * return `shouldLogout: true` on the first cookie expiry, forcing a re-auth it
 * had the credentials to avoid. So the keychain is checked first and these are
 * the fallback, and the next successful refresh writes the result into the
 * keychain — a one-way migration that needs no separate step.
 */
/**
 * How long the device-id lookup will wait on the keychain before falling back.
 *
 * A native call can hang indefinitely — the hazard `getSessionTokenWithTimeout`
 * and `useSigninRecovery` already guard against, both with the same 3s — and
 * `getDeviceInfo` sits inside `refreshBearerSession` with no timeout of its
 * own, so a hung read here would leave a refresh pending forever. The binding
 * is worth waiting a moment for, never worth hanging on.
 */
const BOUND_DEVICE_ID_TIMEOUT_MS = 3000;

const LEGACY_DEVICE_TOKEN_KEY = 'deviceToken';
const LEGACY_DEVICE_ID_KEYS = ['browser_device_id', 'deviceId'] as const;

/** Read a key from localStorage, treating an unavailable store as absent. */
function readLegacy(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Write a key to localStorage.
 *
 * Deliberately *not* tolerant, unlike the read and clear helpers: this is the
 * only place a rotated device token lands, so a swallowed failure here is the
 * silent "persisted nothing" that leaves the next refresh holding a revoked
 * token. Reads and clears can shrug at an unavailable store because neither
 * loses information by failing.
 */
function writeLegacy(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    throw storageError('write', error);
  }
}

/** Drop a key from localStorage, ignoring an unavailable store. */
function clearLegacy(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // A store we cannot write to holds nothing we need to clear.
  }
}

/** The device id the legacy web flow registered, if it left one. */
function readLegacyDeviceId(): string | null {
  for (const key of LEGACY_DEVICE_ID_KEYS) {
    const value = readLegacy(key);
    if (value) return value;
  }
  return null;
}

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

/** `undefined`, `null` and strings are all legal for an optional session field. */
function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

export class AndroidStorage implements PlatformStorage {
  readonly platform = 'android' as const;

  private async keychain() {
    const { PageSpaceKeychain } = await import('@/lib/keychain-plugin');
    return PageSpaceKeychain;
  }

  async getSessionToken(): Promise<string | null> {
    const session = await this.getStoredSession();
    // A legacy cookie session carries an empty `sessionToken` — there is no
    // bearer token to hand out, and `null` says that where `''` only implies it.
    return session?.sessionToken || null;
  }

  /**
   * Read the stored session.
   *
   * Every "the keychain holds nothing usable" path — absent, unparseable, or
   * wrong-shaped — answers with the legacy session, so there is one rule rather
   * than a distinction between kinds of emptiness. `null` therefore means no
   * session at all. A *store failure* is different information and is
   * thrown, not flattened into `null`: every consumer of this method already
   * handles a rejection (`auth-fetch.ts:296-313` logs it and sends the request
   * unauthenticated; `refreshBearerSession` catches it and returns
   * `shouldLogout: false`, i.e. retry later), whereas a `null` there would be
   * read as "device token is gone" and force the user to sign in again over
   * what may be a transient keystore fault.
   *
   * A store fault deliberately does *not* fall through to the legacy session
   * either. A device whose keystore will not initialize cannot persist a
   * refreshed session, so recovering a token here would only buy a session that
   * evaporates on the next launch while hiding the fault that caused it.
   */
  async getStoredSession(): Promise<StoredSession | null> {
    let raw: string | null;
    try {
      const keychain = await this.keychain();
      ({ value: raw } = await keychain.get({ key: SESSION_KEY }));
    } catch (error) {
      throw storageError('read', error);
    }

    if (!raw) return this.remember(this.readLegacySession());

    let parsed: Partial<StoredSession>;
    try {
      parsed = JSON.parse(raw) as Partial<StoredSession>;
    } catch {
      // Unparseable bytes are not a store fault — the store answered.
      return this.remember(this.readLegacySession());
    }

    if (typeof parsed.sessionToken !== 'string' || typeof parsed.deviceId !== 'string') {
      return this.remember(this.readLegacySession());
    }

    // The optional fields get the same treatment as the required ones. `?? null`
    // alone would wave through any non-null value — a number, an object — and
    // hand back something that satisfies `StoredSession` only nominally; those
    // values then travel into a refresh request body.
    if (!isOptionalString(parsed.csrfToken) || !isOptionalString(parsed.deviceToken)) {
      return this.remember(this.readLegacySession());
    }

    return this.remember({
      sessionToken: parsed.sessionToken,
      csrfToken: parsed.csrfToken ?? null,
      deviceId: parsed.deviceId,
      deviceToken: parsed.deviceToken ?? null,
    });
  }

  /**
   * The device id of the last session a read actually returned.
   *
   * `refreshBearerSession` reads the session itself and then asks for the
   * device id separately, and both reads cross the same native bridge with the
   * same 3s budget. When the first lands and the second times out, answering
   * from the legacy store would pair the *keychain's* device token with the
   * *legacy* id — which the refresh route reads as a stolen token, 401s, and
   * then `clearSession` destroys both credentials over what was only a slow
   * keystore. This remembers what the successful read said, so the second
   * question can be answered the same way as the first.
   *
   * Consulted only when a live read fails, so it cannot pin a stale answer the
   * way memoizing `deviceIdPromise` would.
   */
  private lastKnownDeviceId: string | null = null;

  private remember(session: StoredSession | null): StoredSession | null {
    if (session?.deviceId) this.lastKnownDeviceId = session.deviceId;
    return session;
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
    // A session with no bearer token is not a native session, and the keychain
    // is the wrong home for it. It arrives whenever the device record was
    // registered by the in-WebView web flow — which is every Android device
    // until Phase B, since those flows register with `platform: 'web'`. The
    // refresh route branches on that *stored* platform and its web branch
    // (`device/refresh/route.ts`) sets a session **cookie** and returns only
    // `{ csrfToken, deviceToken }`. Writing that here would store a blob
    // `getStoredSession` rejects for want of a `sessionToken`, and spending the
    // legacy copy on top of it would destroy the only token the fallback can
    // recover — a forced sign-out on the very refresh that succeeded.
    //
    // So it goes where the cookie world reads it from, exactly as
    // `WebStorage.storeSession` puts it there. That also persists a *rotated*
    // device token: the web branch returns a new one when the old is near
    // expiry, and dropping it would revoke the client on the next refresh.
    if (!session.sessionToken) {
      if (!session.deviceToken) {
        // Nothing storable in either place, and the contract above promises a
        // throw rather than a false success — `refreshBearerSession` reports
        // "refreshed successfully" on the line after this call.
        throw storageError('write', 'session carries neither a bearer token nor a device token');
      }

      // Write before clearing, never the other way round: `writeLegacy` throws
      // on an unusable store, and a clear that ran first would have destroyed
      // the old token to make room for one that never landed. This order can
      // only leave a *stale* session behind, which the next refresh corrects;
      // the other can leave none at all.
      writeLegacy(LEGACY_DEVICE_TOKEN_KEY, session.deviceToken);

      // Any keychain session is superseded: the server has just told us this
      // device's record is a cookie one. Leaving it would shadow the token
      // written above, because `getStoredSession` reads the keychain first.
      // Best-effort, for the same reason `clearSession` is.
      try {
        const keychain = await this.keychain();
        await keychain.remove({ key: SESSION_KEY });
      } catch (error) {
        console.error(storageError('clear', error).message);
      }
      // Only when nothing claims the key. It belongs to `getOrCreateDeviceId`
      // in `analytics/device-fingerprint` — the browser's stable identity, and
      // what every web sign-in binds its device token to. Overwriting it with
      // whatever `getDeviceInfo()` happened to report would make a divergence
      // permanent instead of recording an identity that was missing.
      // Best-effort, unlike the token above: the token has nowhere else to
      // live, but failing this write after that one landed would report a
      // failure for a refresh that succeeded, sending the caller back into the
      // rate limiter.
      if (session.deviceId && !readLegacyDeviceId()) {
        try {
          writeLegacy(LEGACY_DEVICE_ID_KEYS[0], session.deviceId);
        } catch (error) {
          console.error(storageError('write', error).message);
        }
      }
      this.remember(session);
      return;
    }

    try {
      const keychain = await this.keychain();
      await keychain.set({ key: SESSION_KEY, value: JSON.stringify(session) });
    } catch (error) {
      throw storageError('write', error);
    }
    // The keychain now holds a session that supersedes the legacy one, so the
    // legacy copy is spent. Dropping it here is what makes the migration
    // one-way: `readLegacySession` stops firing and the device identity settles
    // on the session in the keychain.
    clearLegacy(LEGACY_DEVICE_TOKEN_KEY);
    // A write is as good a source of "what is in force" as a read, and a
    // better one right after this branch supersedes what a read last saw.
    this.remember(session);
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
    // Clear everything `getStoredSession` can read, or the legacy fallback
    // would hand the just-revoked device token straight back to the next
    // refresh. The device *id* stays, as it does on web and in preferences —
    // logout ends a session, not a device's identity.
    clearLegacy(LEGACY_DEVICE_TOKEN_KEY);
    this.dispatchAuthEvent('auth:cleared');
  }

  /**
   * The session the web sign-in flow left in `localStorage`, if any.
   *
   * Deliberately shaped exactly like `WebStorage.getStoredSession()` — an empty
   * `sessionToken`, because a cookie session has no bearer token to hand out,
   * and the device token that makes silent recovery work.
   */
  private readLegacySession(): StoredSession | null {
    const deviceToken = readLegacy(LEGACY_DEVICE_TOKEN_KEY);
    if (!deviceToken) return null;
    return { sessionToken: '', csrfToken: null, deviceId: readLegacyDeviceId() ?? '', deviceToken };
  }

  /**
   * The device id the session currently in force is bound to, if any.
   *
   * A store fault is not fatal here — the fallbacks below still name a binding
   * — so unlike `getStoredSession` this swallows it. Losing the binding
   * degrades a refresh; failing to answer at all would break every caller of
   * `getDeviceInfo`.
   */
  private async boundDeviceId(): Promise<string | null> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await Promise.race([
        this.getStoredSession(),
        new Promise<null>((resolve) => {
          timeoutId = setTimeout(() => resolve(null), BOUND_DEVICE_ID_TIMEOUT_MS);
        }),
      ]);
      if (session?.deviceId) return session.deviceId;
    } catch {
      // fall through
    } finally {
      clearTimeout(timeoutId);
    }

    // A keystore that hangs or refuses is no reason to report the *wrong* id.
    // What the last successful read said comes first — it is the only answer
    // that stays consistent with a session already read through this same
    // instance. Then the legacy binding, which lives in localStorage and needs
    // no bridge to read. Only once neither names a binding does the caller fall
    // through to preferences, and a minted id there is precisely the mismatch
    // that gets a refresh rejected as a stolen token.
    return this.lastKnownDeviceId ?? this.readLegacySession()?.deviceId ?? null;
  }

  /**
   * In-flight device-id resolution, shared by concurrent callers.
   *
   * `getDeviceId` is a read-then-write. Two callers that both reach the read
   * before either writes each mint a CUID2, return *different* identities, and
   * leave only one of them persisted — so a refresh could register a device id
   * that is not the one on disk. Sharing the promise makes the first caller the
   * only one that can create an id.
   *
   * Strictly *in-flight*, never a memo: it is cleared once settled. This
   * instance is a module-level singleton, so memoizing would freeze the first
   * answer for the life of the page — and a passkey sign-in happens in-page,
   * establishing a device-token binding *after* an earlier call may already
   * have minted an id. A later caller has to be able to see that binding
   * (`resolveDeviceId`), which a memo would hide until the next reload.
   */
  private deviceIdPromise: Promise<string> | null = null;

  async getDeviceId(): Promise<string> {
    this.deviceIdPromise ??= this.resolveDeviceId().finally(() => {
      this.deviceIdPromise = null;
    });
    return this.deviceIdPromise;
  }

  private async resolveDeviceId(): Promise<string> {
    // The identity of the session in force outranks anything in preferences.
    // `/api/auth/device/refresh` enforces strict binding: a deviceId that does
    // not match the one the token was issued against is treated as a stolen
    // token and answered 401 (`device/refresh/route.ts` via
    // `shouldAllowDeviceRefresh`), and `refreshBearerSession` sends the id from
    // `getDeviceInfo()` rather than from the session it just read. Deriving it
    // from that same session is what keeps the pair it sends consistent —
    // whichever store the session came from, and however many stores hold one.
    const bound = await this.boundDeviceId();

    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: DEVICE_ID_KEY });

    if (bound) {
      // Catch preferences up rather than let it contradict the live binding.
      if (bound !== value) await Preferences.set({ key: DEVICE_ID_KEY, value: bound });
      return bound;
    }

    if (value) return value;

    // CUID2 for consistency across the codebase (matches iOS and web).
    const id = createId();
    await Preferences.set({ key: DEVICE_ID_KEY, value: id });

    // If a legacy device token is live but named no id, publish the minted one
    // where the *server* binding will look for it. `WebStorage.getDeviceId`
    // mints straight into `browser_device_id`, so its two identities converge;
    // minting only into preferences — which no web sign-in path reads — would
    // leave them permanently divergent.
    if (readLegacy(LEGACY_DEVICE_TOKEN_KEY) && !readLegacyDeviceId()) {
      try {
        writeLegacy(LEGACY_DEVICE_ID_KEYS[0], id);
      } catch (error) {
        console.error(storageError('write', error).message);
      }
    }

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
