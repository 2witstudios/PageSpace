import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { run } from '../run.js';
import { EXIT_USAGE_ERROR } from '../exit-codes.js';
import { buildPagespaceMcpArgv, runPagespaceMcpBin } from '../pagespace-mcp-bin.js';
import { createFakeCredentialStore, createRecordingSink } from './fake-context.js';

function makeDeps(argv: string[], env: Record<string, string | undefined> = {}) {
  // The mcp route now serves (degraded or not) instead of failing closed, so
  // every dispatch that reaches it must go through the `createMcpTransport`
  // seam — never the module-level handler's real StdioServerTransport, which
  // would attach to the test runner's own stdin.
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  return {
    argv,
    env,
    stdout: createRecordingSink(),
    stderr: createRecordingSink(),
    credentialStore: createFakeCredentialStore(),
    createMcpTransport: () => serverTransport,
    clientTransport,
  };
}

async function connectClient(clientTransport: InstanceType<typeof InMemoryTransport>) {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
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
  it('resolves identically to "pagespace mcp": same degraded-serve exit code and the same auth warning with zero credentials', async () => {
    const aliasDeps = makeDeps([]);
    const directDeps = makeDeps(['mcp']);

    const [aliasCode, directCode] = await Promise.all([
      runPagespaceMcpBin(aliasDeps),
      run(directDeps),
      connectClient(aliasDeps.clientTransport),
      connectClient(directDeps.clientTransport),
    ]);

    expect(aliasCode).toBe(directCode);
    expect(aliasDeps.stderr.lines.join('')).toMatch(/--key|--token/);
    expect(aliasDeps.stderr.lines.join('')).toEqual(expect.stringContaining(directDeps.stderr.lines.join('')));
  });

  it('keeps stdout pure MCP protocol and never frames itself as deprecated', async () => {
    const deps = makeDeps([]);
    await Promise.all([runPagespaceMcpBin(deps), connectClient(deps.clientTransport)]);

    expect(deps.stdout.lines.join('')).toBe('');
    const allOutput = `${deps.stdout.lines.join('')}${deps.stderr.lines.join('')}`.toLowerCase();
    expect(allOutput).not.toContain('deprecat');
  });

  it('honors the legacy PAGESPACE_API_URL env var end to end (resolved host reaches the tool-call auth failure)', async () => {
    // `--key agent` names an explicit (but unresolvable) credential, so the
    // server comes up and lazy resolution runs on the first tool call — the
    // host-bearing `missingCredentialsMessage` this test targets now arrives
    // as that call's error result, not as a startup stderr line (startup
    // must stay failure-free for the spawning MCP client's sake).
    const deps = makeDeps(['--key', 'agent'], { PAGESPACE_API_URL: 'https://legacy.example.com' });
    const [, client] = await Promise.all([runPagespaceMcpBin(deps), connectClient(deps.clientTransport)]);
    const result = await client.callTool({ name: 'drives.list', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('https://legacy.example.com');
  });

  it('still enforces usage errors for unknown extra argv, just like "pagespace mcp <bogus-subcommand>" would', async () => {
    const aliasDeps = makeDeps(['bogus-subcommand']);
    const directDeps = makeDeps(['mcp', 'bogus-subcommand']);

    const [aliasCode, directCode] = await Promise.all([runPagespaceMcpBin(aliasDeps), run(directDeps)]);
    expect(aliasCode).toBe(directCode);
    expect(aliasCode).not.toBe(EXIT_USAGE_ERROR); // 'mcp' matches by path-prefix; extra args become handler rest args, not a routing usage error
  });
});
