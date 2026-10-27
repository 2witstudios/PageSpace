import { describe, expect, it } from 'vitest';
import { run } from '../run.js';
import { EXIT_USAGE_ERROR } from '../exit-codes.js';
import { buildPagespaceMcpArgv, runPagespaceMcpBin } from '../pagespace-mcp-bin.js';
import { createFakeCredentialStore, createRecordingSink } from './fake-context.js';

function makeDeps(argv: string[], env: Record<string, string | undefined> = {}) {
  return {
    argv,
    env,
    stdout: createRecordingSink(),
    stderr: createRecordingSink(),
    credentialStore: createFakeCredentialStore(),
  };
}

describe('buildPagespaceMcpArgv — pure argv parity', () => {
  it('forces the "mcp" route with no other argv', () => {
    expect(buildPagespaceMcpArgv([])).toEqual(['mcp']);
  });

  it('forwards any extra argv after "mcp" unchanged, matching what "pagespace mcp <flags>" would see', () => {
    expect(buildPagespaceMcpArgv(['--token', 'abc'])).toEqual(['mcp', '--token', 'abc']);
  });
});

describe('runPagespaceMcpBin — the first-class npx entry point, resolved as a plain function of injected deps', () => {
  it('resolves identically to "pagespace mcp": same fail-closed exit code and the same auth-failure message with zero credentials', async () => {
    const aliasDeps = makeDeps([]);
    const directDeps = makeDeps(['mcp']);

    const [aliasCode, directCode] = await Promise.all([runPagespaceMcpBin(aliasDeps), run(directDeps)]);

    expect(aliasCode).toBe(directCode);
    expect(aliasDeps.stderr.lines.join('')).toMatch(/--key|--token/);
    expect(aliasDeps.stderr.lines.join('')).toEqual(expect.stringContaining(directDeps.stderr.lines.join('')));
  });

  it('keeps stdout pure MCP protocol and never frames itself as deprecated', async () => {
    const deps = makeDeps([]);
    await runPagespaceMcpBin(deps);

    expect(deps.stdout.lines.join('')).toBe('');
    const allOutput = `${deps.stdout.lines.join('')}${deps.stderr.lines.join('')}`.toLowerCase();
    expect(allOutput).not.toContain('deprecat');
  });

  it('honors the legacy PAGESPACE_API_URL env var end to end (resolved host reaches the auth-failure message)', async () => {
    // Zero credentials alone now fails closed on the host-agnostic, Phase 8
    // task 4 "no explicit credential" gate before the host is ever
    // consulted (see run.test.ts). `--key agent` makes the credential
    // explicit (an unresolvable named key, not the ambient default) so
    // the flow reaches past that gate into the same host-bearing
    // `missingCredentialsMessage` path this test originally targeted.
    const deps = makeDeps(['--key', 'agent'], { PAGESPACE_API_URL: 'https://legacy.example.com' });
    await runPagespaceMcpBin(deps);
    expect(deps.stderr.lines.join('')).toContain('https://legacy.example.com');
  });

  it('still enforces usage errors for unknown extra argv, just like "pagespace mcp <bogus-subcommand>" would', async () => {
    const aliasDeps = makeDeps(['bogus-subcommand']);
    const directDeps = makeDeps(['mcp', 'bogus-subcommand']);

    const [aliasCode, directCode] = await Promise.all([runPagespaceMcpBin(aliasDeps), run(directDeps)]);
    expect(aliasCode).toBe(directCode);
    expect(aliasCode).not.toBe(EXIT_USAGE_ERROR); // 'mcp' matches by path-prefix; extra args become handler rest args, not a routing usage error
  });
});
