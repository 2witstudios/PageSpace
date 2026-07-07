/**
 * `pagespace keys revoke <tokenId>` (Phase 4 task 6) — destructive.
 * Auth flows only through `ctx.sdk` — see create.ts for why this handler
 * has no auth wiring of its own; by the time this handler runs, `ctx.sdk`
 * is authenticated (or `run.ts`'s `enforceAuth` already exited 1 with a
 * login prompt before dispatch).
 *
 * `--yes` skips confirmation entirely; otherwise a non-TTY session fails
 * closed (must pass `--yes`), and a TTY session is asked to confirm — the
 * same shared `confirmDestructive` gate every other destructive command
 * (`pages trash`, `drives trash`, `tasks delete`, ...) uses, via the
 * `HandlerContext`'s own `isTTY`/`prompt`.
 *
 * `tokensRevoke` is exported separately from `tokensRevokeHandler` purely so
 * tests can call the plain function without going through the router.
 */
import { revokeMcpToken } from '@pagespace/sdk';
import { confirmationFailureMessage, confirmDestructive } from '../../confirm.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { parseTokensRevokeArgs } from './args.js';

export const tokensRevoke: CommandHandler = async (ctx, intent) => {
  const parsed = parseTokensRevokeArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const confirmation = await confirmDestructive(`Revoke token ${parsed.args.tokenId}? This cannot be undone. [y/N] `, {
    isTTY: ctx.isTTY,
    yes: intent.flags.yes,
    prompt: ctx.prompt,
  });
  if (!confirmation.ok) {
    ctx.stderr.write(`${confirmationFailureMessage(confirmation)}\n`);
    return EXIT_RUNTIME_ERROR;
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

export const tokensRevokeHandler: CommandHandler = tokensRevoke;
