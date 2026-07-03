/**
 * CredentialStore — placeholder pending Phase 4 task 2 (OS keychain + chmod
 * 0600 file fallback). The interface is fixed now so the router/handler
 * contract (`HandlerContext.credentialStore`) never has to change shape when
 * the real store lands.
 */
export interface StoredProfile {
  readonly host: string;
  readonly token: string;
}

export interface CredentialStore {
  read(): Promise<StoredProfile | null>;
  write(profile: StoredProfile): Promise<void>;
  clear(): Promise<void>;
}

/** Always empty — no persisted credential. Swapped for the real store in task 2. */
export class NullCredentialStore implements CredentialStore {
  async read(): Promise<StoredProfile | null> {
    return null;
  }

  async write(): Promise<void> {}

  async clear(): Promise<void> {}
}
