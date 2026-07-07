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

describe('createMcpHandler — fails closed with no explicit credential (Phase 8 task 4)', () => {
  it('no --token, no PAGESPACE_TOKEN, no --profile, no PAGESPACE_PROFILE -> refuses to start, transport never touched', async () => {
    let createTransportCalls = 0;
    const handler = createMcpHandler({
      createTransport: () => {
        createTransportCalls += 1;
        throw new Error('should never be reached');
      },
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(ctx, commandIntent(['mcp']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(createTransportCalls).toBe(0);
    expect(stdout.lines).toEqual([]);
    expect(stderr.lines.join('')).toMatch(/never falls back to your personal login/i);
    expect(stderr.lines.join('')).toContain('keys create');
    expect(stderr.lines.join('')).not.toContain('serving');
  });

  it('does not silently fall back to a stored default-profile credential just because one exists', async () => {
    let createTransportCalls = 0;
    const handler = createMcpHandler({
      createTransport: () => {
        createTransportCalls += 1;
        throw new Error('should never be reached');
      },
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    // A stored personal credential existing in ctx.sdk/credentialStore must not matter —
    // the gate only looks at this invocation's own flags/env.
    const code = await handler(ctx, commandIntent(['mcp']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(createTransportCalls).toBe(0);
  });

  it('--profile alone (no --token, no env) is sufficient to start', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const ctx = createFakeContext({ env: {} });
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    const [code] = await Promise.all([
      handler(ctx, commandIntent(['mcp', '--profile', 'agent'])),
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

  it('PAGESPACE_PROFILE env alone (no flags) is sufficient to start', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });

    const ctx = createFakeContext({ env: { PAGESPACE_PROFILE: 'agent' } });
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
