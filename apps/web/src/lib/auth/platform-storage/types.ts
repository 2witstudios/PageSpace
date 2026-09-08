export interface StoredSession {
  sessionToken: string;
  csrfToken: string | null;
  deviceId: string;
  deviceToken: string | null;
}

export interface PlatformStorage {
  readonly platform: 'web' | 'desktop' | 'ios' | 'android';

  getSessionToken(): Promise<string | null>;

  /**
   * The session in force, or `null` when there is none.
   *
   * `null` means "no usable session here" — nothing stored, or stored bytes
   * that cannot be read back as one. A *store fault* is different information
   * and belongs in a rejection: callers treat `null` as "the device token is
   * gone" and force a re-auth (`refreshBearerSession` → `shouldLogout: true`),
   * where a rejection is retryable. Flattening the two signs users out over a
   * transient keystore failure.
   *
   * Every implementation honours this. `IOSStorage` delegates to
   * `native-google-auth.ts`, which used to collapse a Keychain fault into "no
   * session" with a blanket `catch { return null; }`; it now throws on a store
   * fault and reserves `null` for bytes the store actually answered with.
   */
  getStoredSession(): Promise<StoredSession | null>;
  storeSession(session: StoredSession): Promise<void>;
  clearSession(): Promise<void>;

  getDeviceId(): Promise<string>;
  getDeviceInfo(): Promise<{ deviceId: string; userAgent: string; appVersion?: string }>;

  /**
   * Whether this platform prefers to authenticate with a bearer token.
   *
   * A *preference*, not a guarantee that one exists — `auth-fetch` treats it as
   * "try the bearer path first" and falls back to cookie credentials when the
   * store has no token to give.
   *
   * There was a `supportsCSRF()` beside this. It was removed: nothing consulted
   * it any more once the client started mirroring the server's actual rule
   * (attach CSRF when no bearer was attached — `lib/auth/index.ts`), and leaving
   * a method named for the CSRF decision that no longer takes part in it is how
   * the next reader reintroduces the bug it caused. Every adapter reported
   * `usesBearer() === !supportsCSRF()` anyway.
   */
  usesBearer(): boolean;

  dispatchAuthEvent?(event: 'auth:cleared' | 'auth:refreshed' | 'auth:expired'): void;
}
