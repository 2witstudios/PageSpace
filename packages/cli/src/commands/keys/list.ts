/**
 * `pagespace keys list` (Phase 4 task 6). Displays name/prefix/drive
 * scopes/role/created/lastUsed for each of the caller's MCP tokens — never a
 * full token, which the server doesn't return here in the first place
 * (`listMcpTokens`'s output schema has no `token` field at all).
 *
 * Auth flows only through `ctx.sdk` — see create.ts for why this handler
 * has no auth wiring of its own.
 *
 * The one thing it does read directly is `ctx.credentialKind`, and only to
 * refuse. The route behind this command admits a full-user credential only, so
 * a scoped access key gets a 401 there while working perfectly on every
 * content route — which the SDK then reported as the KEY being invalidated
 * (issue #2464). Refusing here means the caller is told what is actually true
 * instead. Same wall `whoami` hits at `/api/auth/me`, same answer: ask a
 * question the credential can be asked (`keys describe`).
 *
 * `tokensList` is exported separately from `tokensListHandler` purely so
 * tests can call the plain function without going through the router.
 */
import type { z } from 'zod';
import { listMcpTokens } from '@pagespace/sdk';
import { keysCommandNeedsLoginMessage } from '../../auth/credential-kind.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { describeEmptyDriveScopes, formatDriveScopeGrant } from './logic.js';

export const tokensList: CommandHandler = async (ctx, intent) => {
  if (ctx.credentialKind === 'key') {
    ctx.stderr.write(`${keysCommandNeedsLoginMessage('list', ctx.credentialSourceKind)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

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
    // Each scope carries its own role, so the drive column names both — a key
    // scoped `member` on one drive and `admin` on another is a real shape, and
    // one summary role for the whole key would misreport it.
    const scopes =
      token.driveScopes.length > 0
        ? token.driveScopes.map(formatDriveScopeGrant).join(', ')
        : describeEmptyDriveScopes(token.isScoped);
    ctx.stdout.write(
      `${token.name}\t${token.tokenPrefix}\t${scopes}\tcreated ${token.createdAt}\tlast used ${token.lastUsed ?? 'never'}\n`,
    );
  }

  return EXIT_SUCCESS;
};

export const tokensListHandler: CommandHandler = tokensList;
