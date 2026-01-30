export interface StoredSession {
  sessionToken: string;
  csrfToken: string | null;
  deviceId: string;
  deviceToken: string | null;
}

export interface PlatformStorage {
  readonly platform: 'web' | 'desktop' | 'ios' | 'android';

  getSessionToken(): Promise<string | null>;
  getStoredSession(): Promise<StoredSession | null>;
  storeSession(session: StoredSession): Promise<void>;
  clearSession(): Promise<void>;

  getDeviceId(): Promise<string>;
  getDeviceInfo(): Promise<{ deviceId: string; userAgent: string; appVersion?: string }>;

  usesBearer(): boolean;
  supportsCSRF(): boolean;

  dispatchAuthEvent?(event: 'auth:cleared' | 'auth:refreshed' | 'auth:expired'): void;
}
