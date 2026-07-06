import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_VERSION, EXIT_SUCCESS, EXIT_USAGE_ERROR, run } from '@pagespace/cli';
import type { HostCredential, RunDependencies } from '@pagespace/cli';
import { createFakeCredentialStore, createRecordingSink } from './fake-context.js';

function makeDeps(argv: string[], env: Record<string, string | undefined> = {}): RunDependencies & {
  stdout: ReturnType<typeof createRecordingSink>;
  stderr: ReturnType<typeof createRecordingSink>;
} {
  return {
    argv,
    env,
    stdout: createRecordingSink(),
    stderr: createRecordingSink(),
    credentialStore: createFakeCredentialStore(),
  };
}

describe('run', () => {
  it('exits 0 and prints usage for "help"', async () => {
    const deps = makeDeps(['help']);
    const code = await run(deps);
    expect(code).toBe(EXIT_SUCCESS);
    expect(deps.stdout.lines.join('')).toContain('pagespace');
  });

  it('exits 0 for --version and reports CLI_VERSION', async () => {
    const deps = makeDeps(['--version']);
    const code = await run(deps);
    expect(code).toBe(EXIT_SUCCESS);
    expect(deps.stdout.lines.join('')).toContain(CLI_VERSION);
  });

  it('exits 2 for an unknown command', async () => {
    const deps = makeDeps(['nope']);
    const code = await run(deps);
    expect(code).toBe(EXIT_USAGE_ERROR);
  });

  it('exits 2 when no command is given at all', async () => {
    const deps = makeDeps([]);
    const code = await run(deps);
    expect(code).toBe(EXIT_USAGE_ERROR);
  });

  it('exits 2 for an unknown flag and never writes it to stdout', async () => {
    const deps = makeDeps(['--bogus']);
    const code = await run(deps);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(deps.stdout.lines).toEqual([]);
  });

  it('never prints a supplied --token value anywhere, even on a usage error', async () => {
    const deps = makeDeps(['--token', 'super-secret-value', '--bogus']);
    await run(deps);
    expect(deps.stdout.lines.join('')).not.toContain('super-secret-value');
    expect(deps.stderr.lines.join('')).not.toContain('super-secret-value');
  });

  it('emits ONLY valid JSON on stdout for "help --json"', async () => {
    const deps = makeDeps(['help', '--json']);
    await run(deps);
    const written = deps.stdout.lines.join('');
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it('reads the credential store exactly once per invocation', async () => {
    let getCalls = 0;
    const store = {
      ...createFakeCredentialStore(),
      async get(host: string) {
        getCalls += 1;
        return null;
      },
    };
    const deps = { ...makeDeps(['help']), credentialStore: store };
    await run(deps);
    expect(getCalls).toBe(1);
  });

  it('never triggers auth enforcement (never writes to stderr, never deletes) for "help" with zero credentials', async () => {
    const store = createFakeCredentialStore();
    let deleteCalls = 0;
    const deps = {
      ...makeDeps(['help']),
      credentialStore: { ...store, delete: async (host: string) => { deleteCalls += 1; return store.delete(host); } },
    };
    const code = await run(deps);
    expect(code).toBe(EXIT_SUCCESS);
    expect(deps.stderr.lines).toEqual([]);
    expect(deleteCalls).toBe(0);
  });

  it('"mcp" is not auth-exempt: fails closed with an actionable message and zero credentials', async () => {
    const deps = makeDeps(['mcp']);
    const code = await run(deps);
    expect(code).not.toBe(EXIT_SUCCESS);
    expect(deps.stderr.lines.join('')).toMatch(/pagespace login|PAGESPACE_TOKEN/);
  });

  describe('"mcp" with a stored default profile but no explicit credential (Phase 8 task 4)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('never touches the personal credential at all: no discovery/refresh network call, no rotation', async () => {
      let networkCalls = 0;
      vi.stubGlobal(
        'fetch',
        (async () => {
          networkCalls += 1;
          throw new Error('run() must never make a network call for mcp with no explicit credential');
        }) as unknown as typeof fetch,
      );

      const store = createFakeCredentialStore();
      const personalCredential: HostCredential = {
        refreshToken: 'ps_rt_personal_secret',
        clientId: 'cli',
        scopes: ['full'],
        createdAt: new Date(0).toISOString(),
      };
      await store.set('https://pagespace.ai', personalCredential, 'default');

      const deps = { ...makeDeps(['mcp']), credentialStore: store };
      const code = await run(deps);

      expect(code).not.toBe(EXIT_SUCCESS);
      expect(deps.stderr.lines.join('')).toContain('tokens create');
      expect(networkCalls).toBe(0);

      const stillStored = await store.get('https://pagespace.ai', 'default');
      expect(stillStored?.refreshToken).toBe('ps_rt_personal_secret');
    });
  });

  it('"drives list" is not auth-exempt either: fails closed with an actionable message and zero credentials', async () => {
    const deps = makeDeps(['drives', 'list']);
    const code = await run(deps);
    expect(code).not.toBe(EXIT_SUCCESS);
    expect(deps.stderr.lines.join('')).toMatch(/pagespace login|PAGESPACE_TOKEN/);
  });

  it('"pages list" is not auth-exempt either: fails closed with an actionable message and zero credentials', async () => {
    const deps = makeDeps(['pages', 'list']);
    const code = await run(deps);
    expect(code).not.toBe(EXIT_SUCCESS);
    expect(deps.stderr.lines.join('')).toMatch(/pagespace login|PAGESPACE_TOKEN/);
  });

  describe('"drives list" with a stored default profile but no explicit credential (Phase 9 task 4 — generalized from Phase 8 task 4)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('never touches the personal credential at all: no discovery/refresh network call, no rotation', async () => {
      let networkCalls = 0;
      vi.stubGlobal(
        'fetch',
        (async () => {
          networkCalls += 1;
          throw new Error('run() must never make a network call for drives list with no explicit credential');
        }) as unknown as typeof fetch,
      );

      const store = createFakeCredentialStore();
      const personalCredential: HostCredential = {
        refreshToken: 'ps_rt_personal_secret',
        clientId: 'cli',
        scopes: ['manage_keys', 'offline_access'],
        createdAt: new Date(0).toISOString(),
      };
      await store.set('https://pagespace.ai', personalCredential, 'default');

      const deps = { ...makeDeps(['drives', 'list']), credentialStore: store };
      const code = await run(deps);

      expect(code).not.toBe(EXIT_SUCCESS);
      expect(deps.stderr.lines.join('')).toContain('tokens create');
      expect(networkCalls).toBe(0);

      const stillStored = await store.get('https://pagespace.ai', 'default');
      expect(stillStored?.refreshToken).toBe('ps_rt_personal_secret');
    });
  });

  describe('exempt commands remain unaffected by the generalized ambient-credential gate (Phase 9 task 4)', () => {
    it('"whoami" never receives the ambient-credential-gate error, even with no explicit token/profile', async () => {
      const deps = makeDeps(['whoami']);
      await run(deps);
      expect(deps.stderr.lines.join('')).not.toContain('No explicit credential found');
    });

    it('"logout" never receives the ambient-credential-gate error, even with no explicit token/profile', async () => {
      const deps = makeDeps(['logout']);
      await run(deps);
      expect(deps.stderr.lines.join('')).not.toContain('No explicit credential found');
    });
  });

  describe('"tokens create" is auth-exempt: it mints via its own browser-consent flow, never the ambient credential (Phase 8)', () => {
    // The real handler's consent flow is covered by its own unit tests
    // (commands/tokens/__tests__/create.test.ts); driving it through run()
    // here would touch the real OS keychain. What only run() can prove is
    // dispatch: with zero stored credentials the handler's own argument
    // validation must be reached, instead of enforceAuth failing first on
    // the missing ambient credential and rotating/refreshing anything.
    it('reaches the handler with zero stored credentials instead of failing ambient-auth enforcement', async () => {
      const deps = makeDeps(['tokens', 'create']);
      const code = await run(deps);
      expect(code).toBe(EXIT_USAGE_ERROR);
      expect(deps.stderr.lines.join('')).toContain('--drive');
      expect(deps.stderr.lines.join('')).not.toContain('pagespace login');
    });

    it('never reads or refreshes the ambient stored profile as a side effect', async () => {
      let networkCalls = 0;
      vi.stubGlobal(
        'fetch',
        (async () => {
          networkCalls += 1;
          throw new Error('tokens create must never touch the ambient credential');
        }) as unknown as typeof fetch,
      );
      try {
        const store = createFakeCredentialStore();
        await store.set('https://pagespace.ai', {
          refreshToken: 'ps_rt_personal_secret',
          clientId: 'cli',
          scopes: ['full'],
          createdAt: new Date(0).toISOString(),
        }, 'default');

        const deps = { ...makeDeps(['tokens', 'create']), credentialStore: store };
        const code = await run(deps);

        expect(code).toBe(EXIT_USAGE_ERROR);
        expect(networkCalls).toBe(0);
        expect((await store.get('https://pagespace.ai', 'default'))?.refreshToken).toBe('ps_rt_personal_secret');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('resolves the profile from --profile and looks up the credential store under that profile name', async () => {
    const profilesSeen: Array<string | undefined> = [];
    const store = {
      ...createFakeCredentialStore(),
      async get(host: string, profile?: string) {
        profilesSeen.push(profile);
        return null;
      },
    };
    const deps = { ...makeDeps(['whoami', '--profile', 'work']), credentialStore: store };
    await run(deps);
    expect(profilesSeen).toEqual(['work']);
  });

  it('PAGESPACE_PROFILE env selects the profile when --profile is absent', async () => {
    const profilesSeen: Array<string | undefined> = [];
    const store = {
      ...createFakeCredentialStore(),
      async get(host: string, profile?: string) {
        profilesSeen.push(profile);
        return null;
      },
    };
    const deps = { ...makeDeps(['whoami'], { PAGESPACE_PROFILE: 'work' }), credentialStore: store };
    await run(deps);
    expect(profilesSeen).toEqual(['work']);
  });

  it('defaults to the "default" profile when neither --profile nor PAGESPACE_PROFILE is given', async () => {
    const profilesSeen: Array<string | undefined> = [];
    const store = {
      ...createFakeCredentialStore(),
      async get(host: string, profile?: string) {
        profilesSeen.push(profile);
        return null;
      },
    };
    const deps = { ...makeDeps(['whoami']), credentialStore: store };
    await run(deps);
    expect(profilesSeen).toEqual(['default']);
  });

  it('folds the legacy PAGESPACE_AUTH_TOKEN env var into the single auth-resolution path with a deprecation notice, never echoing the token', async () => {
    const deps = makeDeps(['whoami'], { PAGESPACE_AUTH_TOKEN: 'ps_legacy_secret_value' });
    await run(deps);
    const stderrText = deps.stderr.lines.join('');
    expect(stderrText).toMatch(/PAGESPACE_AUTH_TOKEN/);
    expect(stderrText).toMatch(/PAGESPACE_TOKEN/);
    expect(stderrText).not.toContain('ps_legacy_secret_value');
  });
});
