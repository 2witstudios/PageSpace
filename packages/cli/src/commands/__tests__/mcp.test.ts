import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, parseArgv } from '@pagespace/cli';
import { createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';
import { createMcpHandler } from '../mcp.js';

function commandIntent(argv: string[]) {
  const intent = parseArgv(argv);
  if (intent.kind !== 'command') throw new Error('expected command');
  return intent;
}

describe('createMcpHandler — thin stdio wiring over ctx.sdk', () => {
  it('connects to the injected transport and serves the full registry (client can list every tool)', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    const [code] = await Promise.all([
      handler(ctx, commandIntent(['mcp', '--token', 'explicit-token'])),
      client.connect(clientTransport),
    ]);

    expect(code).toBe(EXIT_SUCCESS);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(60);
  });

  it('writes a startup diagnostic to stderr only (never stdout)', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      handler(ctx, commandIntent(['mcp', '--token', 'explicit-token'])),
      client.connect(clientTransport),
    ]);

    expect(stdout.lines).toEqual([]);
    expect(stderr.lines.join('')).toContain('pagespace mcp');
  });

  it('returns EXIT_RUNTIME_ERROR and a clean message (no stack trace) when the transport fails to connect', async () => {
    const handler = createMcpHandler({
      createTransport: () => {
        throw new Error('port already in use');
      },
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['mcp', '--token', 'explicit-token']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('port already in use');
    expect(stderr.lines.join('')).not.toMatch(/at .*:\d+:\d+/);
  });
});

describe('createMcpHandler — serves degraded with no explicit credential (Phase 8 task 4 invariant, warn-and-serve failure mode)', () => {
  it('no --token, no PAGESPACE_TOKEN, no --key, no PAGESPACE_KEY -> serves, but every tool call fails with the actionable message and ctx.sdk is never consulted', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    let sdkInvokeCalls = 0;
    const ctx = createFakeContext({
      stdout,
      stderr,
      env: {},
      // A pre-transport exit is indistinguishable from a hung server to the
      // MCP client on the far side of the pipe, so the credential-less case
      // must connect and fail per-call — but strictly through the stub sdk:
      // this recording ctx.sdk proves the ambient client is never touched.
      sdk: {
        invoke: async () => {
          sdkInvokeCalls += 1;
          throw new Error('ctx.sdk must never be consulted without an explicit credential');
        },
      } as never,
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    const [code] = await Promise.all([handler(ctx, commandIntent(['mcp'])), client.connect(clientTransport)]);

    expect(code).toBe(EXIT_SUCCESS);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(60);

    const result = await client.callTool({ name: 'drives.list', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/never falls back to your personal login/i);
    expect(JSON.stringify(result.content)).toContain('keys create');

    expect(sdkInvokeCalls).toBe(0);
    expect(stdout.lines).toEqual([]);
    expect(stderr.lines.join('')).toMatch(/never falls back to your personal login/i);
    expect(stderr.lines.join('')).toContain('serving');
  });

  it('does not silently fall back to a stored default login credential just because one exists', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const stderr = createRecordingSink();
    let sdkInvokeCalls = 0;
    // A stored personal credential existing in ctx.sdk/credentialStore must not matter —
    // the credential check only looks at this invocation's own flags/env, and
    // the served-but-degraded server must fail calls through the stub, never
    // reach for whatever run.ts happened to wire into ctx.sdk.
    const ctx = createFakeContext({
      stderr,
      env: {},
      sdk: {
        invoke: async () => {
          sdkInvokeCalls += 1;
          return { drives: [] };
        },
      } as never,
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    const [code] = await Promise.all([handler(ctx, commandIntent(['mcp'])), client.connect(clientTransport)]);

    expect(code).toBe(EXIT_SUCCESS);
    const result = await client.callTool({ name: 'drives.list', arguments: {} });
    expect(result.isError).toBe(true);
    expect(sdkInvokeCalls).toBe(0);
  });

  it('--key alone (no --token, no env) is sufficient to start', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const ctx = createFakeContext({ env: {} });
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    const [code] = await Promise.all([
      handler(ctx, commandIntent(['mcp', '--key', 'agent'])),
      client.connect(clientTransport),
    ]);

    expect(code).toBe(EXIT_SUCCESS);
  });

  it('PAGESPACE_TOKEN env alone (no flags) is sufficient to start', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const ctx = createFakeContext({ env: { PAGESPACE_TOKEN: 'env-token' } });
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    const [code] = await Promise.all([handler(ctx, commandIntent(['mcp'])), client.connect(clientTransport)]);

    expect(code).toBe(EXIT_SUCCESS);
  });

  it('PAGESPACE_KEY env alone (no flags) is sufficient to start', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const ctx = createFakeContext({ env: { PAGESPACE_KEY: 'agent' } });
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    const [code] = await Promise.all([handler(ctx, commandIntent(['mcp'])), client.connect(clientTransport)]);

    expect(code).toBe(EXIT_SUCCESS);
  });

  it('the legacy PAGESPACE_AUTH_TOKEN env var alone is sufficient to start, keeping npx pagespace-mcp configs working', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const ctx = createFakeContext({ env: { PAGESPACE_AUTH_TOKEN: 'legacy-token' } });
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    const [code] = await Promise.all([handler(ctx, commandIntent(['mcp'])), client.connect(clientTransport)]);

    expect(code).toBe(EXIT_SUCCESS);
  });
});
