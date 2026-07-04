/**
 * `pagespace activity <driveId>` (Phase 5 task 5). Thin projection over the
 * `activity.get` SDK operation (Phase 3 task 9 defined it; this task wires it
 * onto the client facade — see `@pagespace/sdk`'s `client.ts`), scoped to a
 * single drive's activity feed (`context: 'drive'`).
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type ActivityResult = Awaited<ReturnType<PageSpaceClient['activity']['get']>>;

/** Pure: no I/O. */
export function renderActivity(value: ActivityResult): string {
  if (value.activities.length === 0) return 'No activity.\n';
  return `${value.activities
    .map((entry) => `${entry.timestamp}  ${entry.actorEmail}  ${entry.operation} ${entry.resourceType}:${entry.resourceId}`)
    .join('\n')}\n`;
}

export const activityHandler: CommandHandler = async (ctx, intent) => {
  const [driveId, ...extra] = intent.args;
  if (!driveId || extra.length > 0) {
    ctx.stderr.write('Usage: pagespace activity <driveId> [--json]\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.activity.get({ context: 'drive', driveId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }

  ctx.stdout.write(renderActivity(result.value));
  return EXIT_SUCCESS;
};
