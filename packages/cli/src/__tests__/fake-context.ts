import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';
import type { HandlerContext, OutputSink } from '@pagespace/cli';
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
      return [...hosts.entries()].map(([host, credential]) => ({ host, tokenPrefix: credential.refreshToken.slice(0, 12) }));
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
