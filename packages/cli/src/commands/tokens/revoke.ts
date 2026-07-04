/**
 * `pagespace tokens revoke <tokenId>` (Phase 4 task 6) — destructive.
 * Auth flows only through `ctx.sdk` — see create.ts for why this handler
 * has no auth wiring of its own; by the time this handler runs, `ctx.sdk`
 * is authenticated (or `run.ts`'s `enforceAuth` already exited 1 with a
 * login prompt before dispatch).
 *
 * `--yes` skips confirmation entirely; otherwise a non-TTY session fails
 * closed (must pass `--yes`), and a TTY session is asked to confirm.
 *
 * `isTTY`/`confirm` are injected here (not via the shared `HandlerContext`)
 * the same way `login.ts` constructs its own credential store — this
 * command is the CLI's first consumer of an interactive confirmation, and
 * the production wiring lives at the bottom of this file, not in the
 * shared composition root.
 */
import { revokeMcpToken } from '@pagespace/sdk';
import { createInterface } from 'node:readline/promises';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { parseTokensRevokeArgs } from './args.js';

export interface RevokeHandlerDeps {
  readonly isTTY: () => boolean;
  readonly confirm: (message: string) => Promise<boolean>;
}

export function createTokensRevokeHandler(deps: RevokeHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const parsed = parseTokensRevokeArgs(intent.args);
    if (!parsed.ok) {
      ctx.stderr.write(`${parsed.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    if (!intent.flags.yes) {
      if (!deps.isTTY()) {
        ctx.stderr.write('Refusing to revoke a token without confirmation in a non-interactive session. Pass --yes.\n');
        return EXIT_RUNTIME_ERROR;
      }
      const confirmed = await deps.confirm(`Revoke token ${parsed.args.tokenId}? This cannot be undone.`);
      if (!confirmed) {
        ctx.stderr.write('Aborted.\n');
        return EXIT_RUNTIME_ERROR;
      }
    }

    try {
      await ctx.sdk.invoke(revokeMcpToken, { tokenId: parsed.args.tokenId });
    } catch (error) {
      ctx.stderr.write(`Failed to revoke token: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    if (intent.flags.json) {
      ctx.stdout.write(JSON.stringify({ revoked: parsed.args.tokenId }));
    } else {
      ctx.stdout.write(`Revoked token ${parsed.args.tokenId}.\n`);
    }

    return EXIT_SUCCESS;
  };
}

async function readlineConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const tokensRevokeHandler: CommandHandler = createTokensRevokeHandler({
  isTTY: () => process.stdin.isTTY === true,
  confirm: readlineConfirm,
});
