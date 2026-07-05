import { describe, expect, it } from 'vitest';
import { CLI_VERSION, EXIT_SUCCESS, EXIT_USAGE_ERROR, run } from '@pagespace/cli';
import type { RunDependencies } from '@pagespace/cli';
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
