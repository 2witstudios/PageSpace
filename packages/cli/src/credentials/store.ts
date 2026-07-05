/**
 * The public `CredentialStore` contract (`get`/`set`/`delete`/`list` per
 * host) plus the composite implementation: OS keychain first, degrading to
 * the 0600 file store on the first keychain failure (headless Linux with no
 * secret service, CI, denied Keychain access, ...). Degradation is one-way
 * for the lifetime of the store instance and prints exactly one stderr
 * notice — it never crashes and never silently upgrades back to keychain
 * mid-session (that would make "where did this write go?" nondeterministic).
 */
import { FileCredentialStore } from './file-store.js';
import { createNativeKeychainAdapter, keychainAccountKey, parseKeychainAccountKey } from './keychain.js';
import type { KeychainAdapter } from './keychain.js';
import { DEFAULT_PROFILE_NAME, parseHostCredential, serializeHostCredential, tokenPrefix } from './serialize.js';
import type { CredentialSummary, HostCredential } from './serialize.js';

export interface OutputSink {
  write(chunk: string): void;
}

export interface CredentialStore {
  get(host: string, profile?: string): Promise<HostCredential | null>;
  set(host: string, credential: HostCredential, profile?: string): Promise<void>;
  delete(host: string, profile?: string): Promise<void>;
  list(profile?: string): Promise<readonly CredentialSummary[]>;
}

const KEYCHAIN_UNAVAILABLE_NOTICE =
  'pagespace: OS keychain unavailable, falling back to ~/.pagespace/credentials.json for credential storage';

export class CompositeCredentialStore implements CredentialStore {
  private degraded = false;
  private noticeShown = false;

  constructor(
    private readonly keychain: KeychainAdapter,
    private readonly fileStore: CredentialStore,
    private readonly stderr: OutputSink,
  ) {}

  async get(host: string, profile: string = DEFAULT_PROFILE_NAME): Promise<HostCredential | null> {
    return this.withFallback(
      async () => {
        const secret = await this.keychain.getSecret(keychainAccountKey(host, profile));
        return secret === null ? null : parseHostCredential(secret);
      },
      () => this.fileStore.get(host, profile),
    );
  }

  async set(host: string, credential: HostCredential, profile: string = DEFAULT_PROFILE_NAME): Promise<void> {
    return this.withFallback(
      () => this.keychain.setSecret(keychainAccountKey(host, profile), serializeHostCredential(credential)),
      () => this.fileStore.set(host, credential, profile),
    );
  }

  async delete(host: string, profile: string = DEFAULT_PROFILE_NAME): Promise<void> {
    return this.withFallback(
      () => this.keychain.deleteSecret(keychainAccountKey(host, profile)),
      () => this.fileStore.delete(host, profile),
    );
  }

  async list(profile: string = DEFAULT_PROFILE_NAME): Promise<readonly CredentialSummary[]> {
    return this.withFallback(
      async () => {
        const secrets = await this.keychain.listSecrets();
        return secrets
          .map((entry) => ({ ...parseKeychainAccountKey(entry.account), secret: entry.secret }))
          .filter((entry) => entry.profile === profile)
          .map((entry) => ({
            host: entry.host,
            tokenPrefix: tokenPrefix(parseHostCredential(entry.secret).refreshToken),
          }))
          .sort((a, b) => a.host.localeCompare(b.host));
      },
      () => this.fileStore.list(profile),
    );
  }

  private async withFallback<T>(useKeychain: () => Promise<T>, useFile: () => Promise<T>): Promise<T> {
    if (this.degraded) {
      return useFile();
    }
    try {
      return await useKeychain();
    } catch (error) {
      this.degrade(error);
      return useFile();
    }
  }

  private degrade(error: unknown): void {
    this.degraded = true;
    if (!this.noticeShown) {
      this.noticeShown = true;
      const reason = error instanceof Error ? error.message : String(error);
      this.stderr.write(`${KEYCHAIN_UNAVAILABLE_NOTICE} (${reason})\n`);
    }
  }
}

export interface CreateCredentialStoreOptions {
  readonly credentialsPath?: string;
  readonly keychain?: KeychainAdapter;
  readonly stderr?: OutputSink;
}

export function createCredentialStore(options: CreateCredentialStoreOptions = {}): CredentialStore {
  const fileStore = new FileCredentialStore({ path: options.credentialsPath });
  const keychain = options.keychain ?? createNativeKeychainAdapter();
  const stderr: OutputSink = options.stderr ?? {
    write(chunk: string) {
      process.stderr.write(chunk);
    },
  };
  return new CompositeCredentialStore(keychain, fileStore, stderr);
}
