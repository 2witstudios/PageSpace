/**
 * `pagespace tokens create` (Phase 4 task 6). Mirrors the server's
 * `/api/auth/mcp-tokens` POST vocabulary exactly — the server owns all
 * scope-capping (drive access, MEMBER-cannot-grant-ADMIN, custom-role
 * ownership); this handler only maps CLI flags to the request and displays
 * the result.
 *
 * Auth flows only through `ctx.sdk` — `run.ts` already ran this command
 * through the Phase 4 task 7 precedence resolver/`enforceAuth` before
 * dispatch, so by the time this handler runs, `ctx.sdk` is either
 * authenticated or the command never reached here at all.
 *
 * The created token is shown exactly once here — the single sanctioned
 * token display in the whole CLI (everywhere else stays redacted).
 */
import type { z } from 'zod';
import { createMcpToken } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { parseTokensCreateArgs, type DriveScopeArg } from './args.js';

function toDriveInput(drive: DriveScopeArg) {
  return { id: drive.id, role: drive.role, customRoleId: drive.customRoleId };
}

export const tokensCreateHandler: CommandHandler = async (ctx, intent) => {
  const parsed = parseTokensCreateArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  let result: z.infer<typeof createMcpToken.outputSchema>;
  try {
    result = await ctx.sdk.invoke(createMcpToken, {
      name: parsed.args.name,
      drives: parsed.args.drives.length > 0 ? parsed.args.drives.map(toDriveInput) : undefined,
    });
  } catch (error) {
    ctx.stderr.write(`Failed to create token: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  if (intent.flags.json) {
    ctx.stdout.write(JSON.stringify({ name: result.name, token: result.token, drives: result.driveScopes }));
  } else {
    ctx.stdout.write(`Token created: ${result.name}\n`);
    ctx.stdout.write(`${result.token}\n`);
    ctx.stdout.write('Store this token now — it will not be shown again.\n');
    ctx.stdout.write(
      result.driveScopes.length > 0
        ? `Drives: ${result.driveScopes.map((drive) => drive.name).join(', ')}\n`
        : 'Drives: (unscoped — inherits every drive you have access to)\n',
    );
  }

  return EXIT_SUCCESS;
};
