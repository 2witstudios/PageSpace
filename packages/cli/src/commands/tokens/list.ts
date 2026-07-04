/**
 * `pagespace tokens list` (Phase 4 task 6). Displays name/prefix/drive
 * scopes/created/lastUsed for each of the caller's MCP tokens — never a
 * full token, which the server doesn't return here in the first place
 * (`listMcpTokens`'s output schema has no `token` field at all).
 *
 * Auth flows only through `ctx.sdk` — see create.ts for why this handler
 * has no auth wiring of its own.
 */
import type { z } from 'zod';
import { listMcpTokens } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';

export const tokensListHandler: CommandHandler = async (ctx, intent) => {
  let tokens: z.infer<typeof listMcpTokens.outputSchema>;
  try {
    tokens = await ctx.sdk.invoke(listMcpTokens, {});
  } catch (error) {
    ctx.stderr.write(`Failed to list tokens: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  if (intent.flags.json) {
    ctx.stdout.write(JSON.stringify(tokens));
    return EXIT_SUCCESS;
  }

  if (tokens.length === 0) {
    ctx.stdout.write('No tokens found.\n');
    return EXIT_SUCCESS;
  }

  for (const token of tokens) {
    const scopes = token.driveScopes.length > 0 ? token.driveScopes.map((drive) => drive.name).join(', ') : '(unscoped)';
    ctx.stdout.write(
      `${token.name}\t${token.tokenPrefix}\t${scopes}\tcreated ${token.createdAt}\tlast used ${token.lastUsed ?? 'never'}\n`,
    );
  }

  return EXIT_SUCCESS;
};
