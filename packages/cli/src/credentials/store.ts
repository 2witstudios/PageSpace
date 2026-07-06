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
import {
  assertValidAccountKeyInputs,
  createNativeKeychainAdapter,
  keychainAccountKey,
  parseKeychainAccountKey,
} from './keychain.js';
import type { KeychainAdapter, KeychainCredential } from './keychain.js';
import { CredentialsFileFormatError, DEFAULT_PROFILE_NAME, parseHostCredential, serializeHostCredential, tokenPrefix } from './serialize.js';
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

  /**
   * Unlike `set`/`delete`/`list`, this can't route through `withFallback`:
   * a malformed secret makes `parseHostCredential` throw *after* the keychain
   * call already succeeded, and that failure must surface as this one
   * lookup's problem, not get folded into the same catch that decides
   * whether the whole store degrades.
   */
  async get(host: string, profile: string = DEFAULT_PROFILE_NAME): Promise<HostCredential | null> {
    assertValidAccountKeyInputs(host, profile);
    if (this.degraded) {
      return this.fileStore.get(host, profile);
    }

    let secret: string | null;
    try {
      secret = await this.keychain.getSecret(keychainAccountKey(host, profile));
    } catch (error) {
      this.degrade(error);
      return this.fileStore.get(host, profile);
    }

    if (secret === null) return null;

    try {
      return parseHostCredential(secret);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CredentialsFileFormatError(`Keychain entry for ${host} (profile "${profile}") is malformed: ${reason}`);
    }
  }

  async set(host: string, credential: HostCredential, profile: string = DEFAULT_PROFILE_NAME): Promise<void> {
    assertValidAccountKeyInputs(host, profile);
    return this.withFallback(
      () => this.keychain.setSecret(keychainAccountKey(host, profile), serializeHostCredential(credential)),
      () => this.fileStore.set(host, credential, profile),
    );
  }

  async delete(host: string, profile: string = DEFAULT_PROFILE_NAME): Promise<void> {
    assertValidAccountKeyInputs(host, profile);
    return this.withFallback(
      () => this.keychain.deleteSecret(keychainAccountKey(host, profile)),
      () => this.fileStore.delete(host, profile),
    );
  }

  /**
   * Same reasoning as `get()`: one entry failing to parse is that entry's
   * problem, not proof the keychain backend itself is unreachable, so it's
   * skipped with a warning rather than throwing (which would lose every
   * other, well-formed entry) or degrading the whole store.
   */
  async list(profile: string = DEFAULT_PROFILE_NAME): Promise<readonly CredentialSummary[]> {
    if (this.degraded) {
      return this.fileStore.list(profile);
    }

    let secrets: readonly KeychainCredential[];
    try {
      secrets = await this.keychain.listSecrets();
    } catch (error) {
      this.degrade(error);
      return this.fileStore.list(profile);
    }

    const summaries: CredentialSummary[] = [];
    for (const entry of secrets) {
      const account = parseKeychainAccountKey(entry.account);
      if (account.profile !== profile) continue;

      try {
        const credential = parseHostCredential(entry.secret);
        summaries.push({ host: account.host, tokenPrefix: tokenPrefix(credential.refreshToken) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.stderr.write(
          `pagespace: skipping malformed keychain entry for ${account.host} (profile "${account.profile}"): ${reason}\n`,
        );
      }
    }

    return summaries.sort((a, b) => a.host.localeCompare(b.host));
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
