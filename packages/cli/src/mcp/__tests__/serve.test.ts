import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  createRegistry,
  defineOperation,
  getOperation,
  listOperations,
  type Operation,
  type OperationRegistry,
} from '@pagespace/sdk';
import { z } from 'zod';
import { CLI_VERSION } from '../../commands/version.js';
import { buildOperationRegistry, createMcpServer } from '../serve.js';

function fakeSdk(invoke: (op: Operation, input: unknown) => Promise<unknown>) {
  return { invoke };
}

async function connectedClient(registry: OperationRegistry, invoke: (op: Operation, input: unknown) => Promise<unknown>) {
  const server = createMcpServer({ registry, sdk: fakeSdk(invoke) });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('createMcpServer — initialize handshake identity', () => {
  it('reports the real CLI release version, never a hand-maintained copy (the 0.1.0-drift class the 1.5.0 guards kill)', async () => {
    const registry = createRegistry([]);
    const server = createMcpServer({ registry, sdk: fakeSdk(async () => ({})) });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerVersion()).toEqual(expect.objectContaining({ name: 'pagespace', version: CLI_VERSION }));
  });
});

describe('buildOperationRegistry — the full operation surface', () => {
  it('contains every operation exported by the SDK, with no duplicates', () => {
    const registry = buildOperationRegistry();
    const names = listOperations(registry).map((op) => op.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(60);
  });

  it('includes representative operations from every domain', () => {
    const registry = buildOperationRegistry();
    for (const name of ['drives.list', 'pages.replaceLines', 'tasks.create', 'agents.ask', 'calendar.list', 'search.glob', 'roles.list', 'workflows.create']) {
      expect(getOperation(registry, name), `expected ${name} in the full registry`).toBeDefined();
    }
  });
});

describe('createMcpServer — list_tools completeness vs the registry', () => {
  it('lists exactly one MCP tool per registry operation, by name', async () => {
    const registry = buildOperationRegistry();
    const client = await connectedClient(registry, async () => ({}));

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name).sort();
    const registryNames = listOperations(registry)
      .map((op) => op.name)
      .sort();

    expect(toolNames).toEqual(registryNames);
  });

  it('every listed tool carries a non-empty description and an object inputSchema', async () => {
    const registry = buildOperationRegistry();
    const client = await connectedClient(registry, async () => ({}));

    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect((tool.inputSchema as { type: string }).type).toBe('object');
    }
  });
});

describe('createMcpServer — call_tool round trips', () => {
  const echoOp = defineOperation({
    name: 'test.echo',
    method: 'POST',
    path: '/api/test/echo',
    inputSchema: z.object({ message: z.string().min(1) }),
    outputSchema: z.object({ echoed: z.string() }),
    description: 'Echoes a message back.',
  });

  const scopedOp = defineOperation({
    name: 'test.scoped',
    method: 'DELETE',
    path: '/api/test/:id',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ success: z.literal(true) }),
    requiredScope: 'drive:admin',
    description: 'A scoped destructive test operation.',
    destructive: true,
  });

  function registryOf(...ops: readonly Operation[]) {
    return createRegistry(ops);
  }

  it('happy path: validates input, invokes the SDK, and returns the output as content', async () => {
    let received: unknown;
    const client = await connectedClient(registryOf(echoOp), async (_op, input) => {
      received = input;
      return { echoed: (input as { message: string }).message };
    });

    const result = await client.callTool({ name: 'test.echo', arguments: { message: 'hello' } });
    expect(received).toEqual({ message: 'hello' });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('hello');
  });

  it('invalid input: never calls the SDK, returns an MCP-conformant error result (not a protocol crash)', async () => {
    let sdkCalled = false;
    const client = await connectedClient(registryOf(echoOp), async () => {
      sdkCalled = true;
      return {};
    });

    const result = await client.callTool({ name: 'test.echo', arguments: { message: '' } });
    expect(sdkCalled).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('unknown tool: returns an MCP-conformant error result naming the tool, never throws', async () => {
    const client = await connectedClient(registryOf(echoOp), async () => ({}));
    const result = await client.callTool({ name: 'does.not.exist', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('does.not.exist');
  });

  it('permission denied: the error result names the operation\'s required scope', async () => {
    const client = await connectedClient(registryOf(scopedOp), async () => {
      throw new PermissionDeniedError('nope', 'test.scoped');
    });

    const result = await client.callTool({ name: 'test.scoped', arguments: { id: 'x' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('drive:admin');
  });

  it('authentication failure surfaces as a distinct, actionable error result', async () => {
    const client = await connectedClient(registryOf(echoOp), async () => {
      throw new AuthenticationError('nope', 'test.echo');
    });

    const result = await client.callTool({ name: 'test.echo', arguments: { message: 'hi' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/login|token/i);
  });

  it('not-found surfaces distinctly from permission-denied', async () => {
    const client = await connectedClient(registryOf(echoOp), async () => {
      throw new NotFoundError('nope', 'test.echo');
    });

    const result = await client.callTool({ name: 'test.echo', arguments: { message: 'hi' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain('drive:admin');
  });

  it('never leaks a stack trace or token material for an unexpected thrown error', async () => {
    const client = await connectedClient(registryOf(echoOp), async () => {
      const err = new Error('leaked ps_supersecrettoken123');
      err.stack = 'Error: leaked ps_supersecrettoken123\n    at handler (/app/secret.ts:1:1)';
      throw err;
    });

    const result = await client.callTool({ name: 'test.echo', arguments: { message: 'hi' } });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).not.toContain('ps_supersecrettoken123');
    expect(text).not.toContain('/app/secret.ts');
  });
});
