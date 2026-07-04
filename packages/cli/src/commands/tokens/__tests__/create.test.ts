import { describe, expect, it, vi } from 'vitest';
import type { PageSpaceClient } from '@pagespace/sdk';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../../exit-codes.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import { tokensCreateHandler } from '../create.js';

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

function fakeSdk(invoke: ReturnType<typeof vi.fn>): PageSpaceClient {
  return { invoke } as unknown as PageSpaceClient;
}

const CREATE_RESPONSE = {
  id: 'tok_1',
  name: 'CI bot',
  token: 'mcp_plaintext_once_only',
  createdAt: '2026-07-03T00:00:00.000Z',
  lastUsed: null,
  driveScopes: [{ id: 'drv1', name: 'Engineering' }],
};

describe('tokensCreateHandler', () => {
  it('rejects a missing --name as a usage error without touching the SDK', async () => {
    const invoke = vi.fn();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk(invoke) });

    const code = await tokensCreateHandler(ctx, commandIntent(['tokens', 'create']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(invoke).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toContain('--name');
  });

  it('calls the SDK with the mapped name/drives and prints the token exactly once with a warning', async () => {
    const invoke = vi.fn(async () => CREATE_RESPONSE);
    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, sdk: fakeSdk(invoke) });

    const code = await tokensCreateHandler(
      ctx,
      commandIntent(['tokens', 'create', '--name', 'CI bot', '--drive', 'drv1', '--role', 'member', '--drive', 'drv2', '--role', 'role-xyz']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(invoke).toHaveBeenCalledTimes(1);
    const input = (invoke.mock.calls[0] as unknown[])[1] as { name: string; drives: unknown[] };
    expect(input).toEqual({
      name: 'CI bot',
      drives: [
        { id: 'drv1', role: 'MEMBER' },
        { id: 'drv2', role: null, customRoleId: 'role-xyz' },
      ],
    });

    const output = stdout.lines.join('');
    const occurrences = output.split(CREATE_RESPONSE.token).length - 1;
    expect(occurrences).toBe(1);
    expect(output.toLowerCase()).toContain('store this');
    expect(stderr.lines.join('')).toBe('');
  });

  it('emits { name, token, drives } as the only JSON shape with --json', async () => {
    const invoke = vi.fn(async () => CREATE_RESPONSE);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk(invoke) });

    const code = await tokensCreateHandler(ctx, commandIntent(['tokens', 'create', '--name', 'CI bot', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(stdout.lines.join(''));
    expect(parsed).toEqual({ name: 'CI bot', token: CREATE_RESPONSE.token, drives: CREATE_RESPONSE.driveScopes });
  });

  it('exits 1 and never shows a token when the SDK call fails', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('drive access denied');
    });
    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, sdk: fakeSdk(invoke) });

    const code = await tokensCreateHandler(ctx, commandIntent(['tokens', 'create', '--name', 'CI bot']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('drive access denied');
    expect(stdout.lines.join('')).toBe('');
  });

  it('sends no drives field for an unscoped token', async () => {
    const invoke = vi.fn(async () => ({ ...CREATE_RESPONSE, driveScopes: [] }));
    const ctx = createFakeContext({ sdk: fakeSdk(invoke) });

    await tokensCreateHandler(ctx, commandIntent(['tokens', 'create', '--name', 'CI bot']));

    const input = (invoke.mock.calls[0] as unknown[])[1] as { drives?: unknown[] };
    expect(input.drives).toBeUndefined();
  });
});
