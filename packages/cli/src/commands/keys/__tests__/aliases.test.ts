import { describe, expect, it, vi } from 'vitest';
import type { PageSpaceClient } from '@pagespace/sdk';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../../../exit-codes.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import { tokensListHandler } from '../../tokens/list.js';
import { tokensRevokeHandler } from '../../tokens/revoke.js';
import { keysListHandler, keysRevokeHandler } from '../aliases.js';

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

function fakeSdk(invoke: ReturnType<typeof vi.fn>): PageSpaceClient {
  return { invoke } as unknown as PageSpaceClient;
}

describe('keysListHandler', () => {
  it('is a distinct function reference from tokensListHandler — AUTH_EXEMPT_HANDLERS gates by identity', () => {
    expect(keysListHandler).not.toBe(tokensListHandler);
  });

  it('delegates to the exact same listing logic (name/prefix/scopes rendered identically)', async () => {
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
    ];
    const invoke = vi.fn(async () => TOKENS);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk(invoke) });

    const code = await keysListHandler(ctx, commandIntent(['keys', 'list']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('CI bot');
    expect(stdout.lines.join('')).toContain('Engineering');
  });
});

describe('keysRevokeHandler', () => {
  it('is a distinct function reference from tokensRevokeHandler — AUTH_EXEMPT_HANDLERS gates by identity', () => {
    expect(keysRevokeHandler).not.toBe(tokensRevokeHandler);
  });

  it('delegates to the exact same revoke logic, including the --yes/non-TTY confirmation gate', async () => {
    const invoke = vi.fn();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk(invoke), isTTY: false });

    const code = await keysRevokeHandler(ctx, commandIntent(['keys', 'revoke', 'tok_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('--yes');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('revokes immediately with --yes', async () => {
    const invoke = vi.fn(async () => ({ message: 'Token revoked successfully' }));
    const ctx = createFakeContext({ sdk: fakeSdk(invoke), isTTY: false });

    const code = await keysRevokeHandler(ctx, commandIntent(['keys', 'revoke', 'tok_1', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(invoke).toHaveBeenCalledWith(expect.anything(), { tokenId: 'tok_1' });
  });
});
