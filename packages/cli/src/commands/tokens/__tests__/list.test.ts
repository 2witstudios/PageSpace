import { describe, expect, it, vi } from 'vitest';
import type { PageSpaceClient } from '@pagespace/sdk';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../../../exit-codes.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import { tokensListHandler } from '../list.js';

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

function fakeSdk(invoke: ReturnType<typeof vi.fn>): PageSpaceClient {
  return { invoke } as unknown as PageSpaceClient;
}

const TOKENS = [
  {
    id: 't1',
    name: 'CI bot',
    tokenPrefix: 'mcp_abcdefghijk',
    lastUsed: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    isScoped: true,
    driveScopes: [{ id: 'd1', name: 'Engineering' }],
  },
  {
    id: 't2',
    name: 'Full access key',
    tokenPrefix: 'mcp_zzzzzzzzzzz',
    lastUsed: '2026-07-02T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    isScoped: false,
    driveScopes: [],
  },
];

describe('tokensListHandler', () => {
  it('never prints a full token — only the prefix — for each listed token', async () => {
    const invoke = vi.fn(async () => TOKENS);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk(invoke) });

    const code = await tokensListHandler(ctx, commandIntent(['tokens', 'list']));

    expect(code).toBe(EXIT_SUCCESS);
    const output = stdout.lines.join('');
    expect(output).toContain('CI bot');
    expect(output).toContain('mcp_abcdefghijk');
    expect(output).toContain('Full access key');
    expect(output).toContain('Engineering');
  });

  it('emits the raw token array as JSON with --json', async () => {
    const invoke = vi.fn(async () => TOKENS);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk(invoke) });

    const code = await tokensListHandler(ctx, commandIntent(['tokens', 'list', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(TOKENS);
  });

  it('prints a friendly message when there are no tokens', async () => {
    const invoke = vi.fn(async () => []);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk(invoke) });

    const code = await tokensListHandler(ctx, commandIntent(['tokens', 'list']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('').length).toBeGreaterThan(0);
  });

  it('exits 1 when the SDK call fails', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('server unreachable');
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk(invoke) });

    const code = await tokensListHandler(ctx, commandIntent(['tokens', 'list']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('server unreachable');
  });
});
