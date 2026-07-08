import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';
import { credentialSecret } from '@pagespace/cli';
import type { ActiveKeyStore, HandlerContext, OutputSink } from '@pagespace/cli';
import type { CredentialStore, HostCredential } from '@pagespace/cli';

export function createRecordingSink(): OutputSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
    },
  };
}

/** Always empty, in-memory — no real fs/keychain I/O. Good enough for tests that don't care about credential storage. */
export function createFakeCredentialStore(): CredentialStore {
  const hosts = new Map<string, HostCredential>();
  return {
    async get(host: string) {
      return hosts.get(host) ?? null;
    },
    async set(host: string, credential: HostCredential) {
      hosts.set(host, credential);
    },
    async delete(host: string) {
      hosts.delete(host);
    },
    async list() {
      return [...hosts.entries()].map(([host, credential]) => ({ host, tokenPrefix: credentialSecret(credential).slice(0, 12) }));
    },
  };
}

/** In-memory host → active-key-name map — no real fs I/O. */
export function createFakeActiveKeyStore(initial: Record<string, string> = {}): ActiveKeyStore & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    async getActiveKey(host: string) {
      return entries.get(host) ?? null;
    },
    async setActiveKey(host: string, name: string) {
      entries.set(host, name);
    },
    async clearActiveKey(host: string) {
      entries.delete(host);
    },
  };
}

export function createFakeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    sdk: new PageSpaceClient({ baseUrl: 'https://pagespace.ai', auth: new StaticTokenProvider('test-token') }),
    stdout: createRecordingSink(),
    stderr: createRecordingSink(),
    env: {},
    credentialStore: createFakeCredentialStore(),
    activeKeyStore: createFakeActiveKeyStore(),
    isTTY: false,
    prompt: async () => '',
    ...overrides,
  };
}

/**
 * Casts a plain object stubbing only the namespace methods a command actually
 * calls into a `PageSpaceClient` — the class has private fields, so no object
 * literal is structurally assignable without this. Command tests build the
 * minimal shape they need (e.g. `{ drives: { list: async () => [...] } }`)
 * and pass the result as `createFakeContext({ sdk: fakeSdk(...) })`.
 */
export function fakeSdk(shape: Record<string, unknown>): PageSpaceClient {
  return shape as unknown as PageSpaceClient;
}
