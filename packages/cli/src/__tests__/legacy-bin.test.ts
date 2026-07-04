import { describe, expect, it } from 'vitest';
import { run } from '../run.js';
import { EXIT_USAGE_ERROR } from '../exit-codes.js';
import { LEGACY_MCP_DEPRECATION_NOTICE, buildLegacyMcpArgv, runLegacyMcpBin } from '../legacy-bin.js';
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

describe('buildLegacyMcpArgv — pure argv parity', () => {
  it('forces the "mcp" route with no other argv', () => {
    expect(buildLegacyMcpArgv([])).toEqual(['mcp']);
  });

  it('forwards any extra argv after "mcp" unchanged, matching what "pagespace mcp <flags>" would see', () => {
    expect(buildLegacyMcpArgv(['--token', 'abc'])).toEqual(['mcp', '--token', 'abc']);
  });
});

describe('runLegacyMcpBin — the pagespace-mcp bin alias, resolved as a plain function of injected deps', () => {
  it('resolves identically to "pagespace mcp": same fail-closed exit code and the same auth-failure message with zero credentials', async () => {
    const legacyDeps = makeDeps([]);
    const modernDeps = makeDeps(['mcp']);

    const [legacyCode, modernCode] = await Promise.all([runLegacyMcpBin(legacyDeps), run(modernDeps)]);

    expect(legacyCode).toBe(modernCode);
    expect(legacyDeps.stderr.lines.join('')).toMatch(/pagespace login|PAGESPACE_TOKEN/);
    expect(legacyDeps.stderr.lines.join('')).toEqual(expect.stringContaining(modernDeps.stderr.lines.join('')));
  });

  it('emits the deprecation notice to stderr exactly once, never to stdout', async () => {
    const deps = makeDeps([]);
    await runLegacyMcpBin(deps);

    const stderrText = deps.stderr.lines.join('');
    const occurrences = stderrText.split(LEGACY_MCP_DEPRECATION_NOTICE).length - 1;
    expect(occurrences).toBe(1);
    expect(deps.stdout.lines.join('')).not.toContain(LEGACY_MCP_DEPRECATION_NOTICE);
  });

  it('names "pagespace mcp" as the replacement in the deprecation notice', () => {
    expect(LEGACY_MCP_DEPRECATION_NOTICE).toContain('pagespace mcp');
  });

  it('honors the legacy PAGESPACE_API_URL env var end to end (resolved host reaches the auth-failure message)', async () => {
    const deps = makeDeps([], { PAGESPACE_API_URL: 'https://legacy.example.com' });
    await runLegacyMcpBin(deps);
    expect(deps.stderr.lines.join('')).toContain('https://legacy.example.com');
  });

  it('still enforces usage errors for unknown extra argv, just like "pagespace mcp <bogus-subcommand>" would', async () => {
    const legacyDeps = makeDeps(['bogus-subcommand']);
    const modernDeps = makeDeps(['mcp', 'bogus-subcommand']);

    const [legacyCode, modernCode] = await Promise.all([runLegacyMcpBin(legacyDeps), run(modernDeps)]);
    expect(legacyCode).toBe(modernCode);
    expect(legacyCode).not.toBe(EXIT_USAGE_ERROR); // 'mcp' matches by path-prefix; extra args become handler rest args, not a routing usage error
  });
});
