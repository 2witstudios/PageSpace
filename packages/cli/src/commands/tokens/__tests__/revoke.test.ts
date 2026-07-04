import { describe, expect, it, vi } from 'vitest';
import type { PageSpaceClient } from '@pagespace/sdk';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../../exit-codes.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import { tokensRevokeHandler } from '../revoke.js';

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

function fakeSdk(invoke: ReturnType<typeof vi.fn>): PageSpaceClient {
  return { invoke } as unknown as PageSpaceClient;
}

describe('tokensRevokeHandler', () => {
  it('rejects a missing tokenId as a usage error without touching the SDK', async () => {
    const invoke = vi.fn();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk(invoke), isTTY: true });

    const code = await tokensRevokeHandler(ctx, commandIntent(['tokens', 'revoke']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requires --yes in a non-TTY session and never calls the SDK', async () => {
    const invoke = vi.fn();
    const prompt = vi.fn();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk(invoke), isTTY: false, prompt });

    const code = await tokensRevokeHandler(ctx, commandIntent(['tokens', 'revoke', 'tok_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('--yes');
    expect(prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips confirmation and revokes immediately with --yes', async () => {
    const invoke = vi.fn(async () => ({ message: 'Token revoked successfully' }));
    const prompt = vi.fn();
    const ctx = createFakeContext({ sdk: fakeSdk(invoke), isTTY: false, prompt });

    const code = await tokensRevokeHandler(ctx, commandIntent(['tokens', 'revoke', 'tok_1', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(expect.anything(), { tokenId: 'tok_1' });
  });

  it('prompts interactively in a TTY without --yes, and proceeds when confirmed', async () => {
    const invoke = vi.fn(async () => ({ message: 'Token revoked successfully' }));
    const prompt = vi.fn(async () => 'y');
    const ctx = createFakeContext({ sdk: fakeSdk(invoke), isTTY: true, prompt });

    const code = await tokensRevokeHandler(ctx, commandIntent(['tokens', 'revoke', 'tok_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('aborts without calling the SDK when the interactive confirmation is declined', async () => {
    const invoke = vi.fn();
    const prompt = vi.fn(async () => 'n');
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk(invoke), isTTY: true, prompt });

    const code = await tokensRevokeHandler(ctx, commandIntent(['tokens', 'revoke', 'tok_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(invoke).not.toHaveBeenCalled();
    expect(stderr.lines.join('').toLowerCase()).toContain('abort');
  });

  it('exits 1 when the SDK revoke call fails', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('token not found');
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk(invoke), isTTY: false });

    const code = await tokensRevokeHandler(ctx, commandIntent(['tokens', 'revoke', 'tok_1', '--yes']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('token not found');
  });
});
