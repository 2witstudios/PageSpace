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

    const [code] = await Promise.all([handler(ctx, commandIntent(['mcp'])), client.connect(clientTransport)]);

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

    await Promise.all([handler(ctx, commandIntent(['mcp'])), client.connect(clientTransport)]);

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
    const code = await handler(ctx, commandIntent(['mcp']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('port already in use');
    expect(stderr.lines.join('')).not.toMatch(/at .*:\d+:\d+/);
  });
});
