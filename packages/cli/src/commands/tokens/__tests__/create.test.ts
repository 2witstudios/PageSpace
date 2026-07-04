import { describe, expect, it, vi } from 'vitest';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../../exit-codes.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import { createTokensCreateHandler } from '../create.js';
import type { TokensSessionResult } from '../session.js';

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

const CREATE_RESPONSE = {
  id: 'tok_1',
  name: 'CI bot',
  token: 'mcp_plaintext_once_only',
  createdAt: '2026-07-03T00:00:00.000Z',
  lastUsed: null,
  driveScopes: [{ id: 'drv1', name: 'Engineering' }],
};

function okSession(invoke: ReturnType<typeof vi.fn>): TokensSessionResult {
  return { outcome: 'ok', sdk: { invoke } };
}

describe('createTokensCreateHandler', () => {
  it('rejects a missing --name as a usage error without touching the session', async () => {
    const resolveSession = vi.fn();
    const handler = createTokensCreateHandler({ resolveSession });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['tokens', 'create']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(resolveSession).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toContain('--name');
  });

  it('exits 1 with a login prompt when unauthenticated, never calling the SDK', async () => {
    const invoke = vi.fn();
    const resolveSession = vi.fn(async (): Promise<TokensSessionResult> => ({ outcome: 'unauthenticated' }));
    const handler = createTokensCreateHandler({ resolveSession });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['tokens', 'create', '--name', 'CI bot']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('pagespace login');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exits 1 when session resolution throws', async () => {
    const resolveSession = vi.fn(async () => {
      throw new Error('discovery unreachable');
    });
    const handler = createTokensCreateHandler({ resolveSession });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['tokens', 'create', '--name', 'CI bot']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('discovery unreachable');
  });

  it('calls the SDK with the mapped name/drives and prints the token exactly once with a warning', async () => {
    const invoke = vi.fn(async () => CREATE_RESPONSE);
    const resolveSession = vi.fn(async () => okSession(invoke));
    const handler = createTokensCreateHandler({ resolveSession });
    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr });

    const code = await handler(
      ctx,
      commandIntent(['tokens', 'create', '--name', 'CI bot', '--drive', 'drv1', '--role', 'member', '--drive', 'drv2', '--role', 'role-xyz']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [, input] = invoke.mock.calls[0] as [unknown, { name: string; drives: unknown[] }];
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
    const resolveSession = vi.fn(async () => okSession(invoke));
    const handler = createTokensCreateHandler({ resolveSession });
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout });

    const code = await handler(ctx, commandIntent(['tokens', 'create', '--name', 'CI bot', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(stdout.lines.join(''));
    expect(parsed).toEqual({ name: 'CI bot', token: CREATE_RESPONSE.token, drives: CREATE_RESPONSE.driveScopes });
  });

  it('exits 1 and never shows a token when the SDK call fails', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('drive access denied');
    });
    const resolveSession = vi.fn(async () => okSession(invoke));
    const handler = createTokensCreateHandler({ resolveSession });
    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr });

    const code = await handler(ctx, commandIntent(['tokens', 'create', '--name', 'CI bot']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('drive access denied');
    expect(stdout.lines.join('')).toBe('');
  });

  it('sends no drives field for an unscoped token', async () => {
    const invoke = vi.fn(async () => ({ ...CREATE_RESPONSE, driveScopes: [] }));
    const resolveSession = vi.fn(async () => okSession(invoke));
    const handler = createTokensCreateHandler({ resolveSession });
    const ctx = createFakeContext();

    await handler(ctx, commandIntent(['tokens', 'create', '--name', 'CI bot']));

    const [, input] = invoke.mock.calls[0] as [unknown, { drives?: unknown[] }];
    expect(input.drives).toBeUndefined();
  });
});
