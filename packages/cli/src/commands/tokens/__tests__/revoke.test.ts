import { describe, expect, it, vi } from 'vitest';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../../exit-codes.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import { createTokensRevokeHandler } from '../revoke.js';
import type { TokensSessionResult } from '../session.js';

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

function okSession(invoke: ReturnType<typeof vi.fn>): TokensSessionResult {
  return { outcome: 'ok', sdk: { invoke } };
}

describe('createTokensRevokeHandler', () => {
  it('rejects a missing tokenId as a usage error without resolving a session', async () => {
    const resolveSession = vi.fn();
    const handler = createTokensRevokeHandler({ resolveSession, isTTY: () => true, confirm: vi.fn() });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['tokens', 'revoke']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('exits 1 with a login prompt when unauthenticated, never prompting for confirmation', async () => {
    const confirm = vi.fn();
    const resolveSession = vi.fn(async (): Promise<TokensSessionResult> => ({ outcome: 'unauthenticated' }));
    const handler = createTokensRevokeHandler({ resolveSession, isTTY: () => true, confirm });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['tokens', 'revoke', 'tok_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('pagespace login');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('requires --yes in a non-TTY session and never calls the SDK', async () => {
    const invoke = vi.fn();
    const resolveSession = vi.fn(async () => okSession(invoke));
    const confirm = vi.fn();
    const handler = createTokensRevokeHandler({ resolveSession, isTTY: () => false, confirm });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['tokens', 'revoke', 'tok_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('--yes');
    expect(confirm).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips confirmation and revokes immediately with --yes', async () => {
    const invoke = vi.fn(async () => ({ message: 'Token revoked successfully' }));
    const resolveSession = vi.fn(async () => okSession(invoke));
    const confirm = vi.fn();
    const handler = createTokensRevokeHandler({ resolveSession, isTTY: () => false, confirm });
    const ctx = createFakeContext();

    const code = await handler(ctx, commandIntent(['tokens', 'revoke', 'tok_1', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(confirm).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(expect.anything(), { tokenId: 'tok_1' });
  });

  it('prompts interactively in a TTY without --yes, and proceeds when confirmed', async () => {
    const invoke = vi.fn(async () => ({ message: 'Token revoked successfully' }));
    const resolveSession = vi.fn(async () => okSession(invoke));
    const confirm = vi.fn(async () => true);
    const handler = createTokensRevokeHandler({ resolveSession, isTTY: () => true, confirm });
    const ctx = createFakeContext();

    const code = await handler(ctx, commandIntent(['tokens', 'revoke', 'tok_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('aborts without calling the SDK when the interactive confirmation is declined', async () => {
    const invoke = vi.fn();
    const resolveSession = vi.fn(async () => okSession(invoke));
    const confirm = vi.fn(async () => false);
    const handler = createTokensRevokeHandler({ resolveSession, isTTY: () => true, confirm });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['tokens', 'revoke', 'tok_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(invoke).not.toHaveBeenCalled();
    expect(stderr.lines.join('').toLowerCase()).toContain('abort');
  });

  it('exits 1 when the SDK revoke call fails', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('token not found');
    });
    const resolveSession = vi.fn(async () => okSession(invoke));
    const handler = createTokensRevokeHandler({ resolveSession, isTTY: () => false, confirm: vi.fn() });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['tokens', 'revoke', 'tok_1', '--yes']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('token not found');
  });
});
