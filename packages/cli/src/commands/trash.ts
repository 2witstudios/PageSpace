/**
 * `pagespace trash list --drive <id>` (Phase 5 task 1) — a thin projection
 * over `pages.listTrash`, exposed under its own `trash` resource per the
 * phase task's explicit grammar rather than as a `pages` sub-verb. Unlike
 * `pages.list`'s ls-mode, this operation's response is a genuine nested tree
 * (each node carries real `children`), so — unlike `pages tree` — human-mode
 * rendering here can indent by true depth with zero ambiguity.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { extractDriveFlag } from './drive-flag.js';
import { callSdk } from './sdk-error.js';

type TrashNode = Awaited<ReturnType<PageSpaceClient['pages']['listTrash']>>[number];

/** Pure: no I/O. Renders the real trash tree, indenting by true depth. */
export function renderTrashTree(nodes: readonly TrashNode[], depth = 0): string {
  const indent = '  '.repeat(depth);
  return nodes
    .map((node) => `${indent}${node.type}  ${node.id}  ${node.title ?? '(untitled)'}\n${renderTrashTree(node.children as TrashNode[], depth + 1)}`)
    .join('');
}

export const trashListHandler: CommandHandler = async (ctx, intent) => {
  const extracted = extractDriveFlag(intent.args);
  if (!extracted.ok) {
    ctx.stderr.write(`${extracted.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (!extracted.driveId) {
    ctx.stderr.write('Usage: pagespace trash list --drive <driveId>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.pages.listTrash({ driveId: extracted.driveId as string }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(result.value.length === 0 ? 'Trash is empty.\n' : renderTrashTree(result.value));
  }
  return EXIT_SUCCESS;
};
