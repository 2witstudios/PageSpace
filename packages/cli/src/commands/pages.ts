/**
 * `pagespace pages list|tree|read-details|create|rename|move|trash|restore`
 * (Phase 5 task 1). Thin projections over the `pages.*` SDK operations.
 *
 * `pages tree`: `pages.list`'s ls-mode response (Phase 3) is a flat,
 * preorder-DFS array of `{id, type, hasChildren}` with no `parentId`/depth
 * field, so a single recursive call cannot be unambiguously re-nested
 * (two different trees can produce the identical flat sequence). `--json`
 * stays a single `recursive: true` call — exactly the raw SDK response, per
 * law. Human mode additionally fetches the non-recursive listing at the
 * same location (same operation, one more call) purely to know which ids
 * are direct children, giving an honest two-level indent (root vs. nested)
 * instead of a fabricated deeper hierarchy the wire data can't support.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { pageTypeSchema } from '@pagespace/sdk';
import { confirmationFailureMessage, confirmDestructive } from '../confirm.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { extractDriveFlag } from './drive-flag.js';
import { callSdk } from './sdk-error.js';

type PagesListResult = Awaited<ReturnType<PageSpaceClient['pages']['list']>>;
type PagesListEntry = PagesListResult['pages'][number];
type PageRecord = Awaited<ReturnType<PageSpaceClient['pages']['create']>>;

/** Pure: no I/O. */
export function renderPagesList(result: PagesListResult): string {
  if (result.pages.length === 0) {
    return 'No pages.\n';
  }
  return result.pages.map((page) => `${page.type}  ${page.id}  ${page.title ?? '(untitled)'}\n`).join('');
}

/** Pure: no I/O. Two-level indent (root vs. nested) — see module doc comment for why. */
export function renderPagesTree(recursive: PagesListResult, rootIds: ReadonlySet<string>): string {
  if (recursive.pages.length === 0) {
    return 'No pages.\n';
  }
  return recursive.pages
    .map((page: PagesListEntry) => {
      const indent = rootIds.has(page.id) ? '' : '  ';
      return `${indent}${page.type}  ${page.id}  ${page.title ?? '(untitled)'}\n`;
    })
    .join('');
}

/** Pure: no I/O. */
export function renderPage(page: PageRecord): string {
  return `${page.type}  ${page.id}  ${page.title ?? '(untitled)'}\n`;
}

export const pagesListHandler: CommandHandler = async (ctx, intent) => {
  const extracted = extractDriveFlag(intent.args);
  if (!extracted.ok) {
    ctx.stderr.write(`${extracted.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (!extracted.driveId) {
    ctx.stderr.write('Usage: pagespace pages list --drive <driveId> [parentId]\n');
    return EXIT_USAGE_ERROR;
  }
  const [parentId] = extracted.rest;

  const result = await callSdk(ctx.stderr, () => ctx.sdk.pages.list({ driveId: extracted.driveId as string, parentId, ls: true }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(renderPagesList(result.value));
  }
  return EXIT_SUCCESS;
};

export const pagesTreeHandler: CommandHandler = async (ctx, intent) => {
  const extracted = extractDriveFlag(intent.args);
  if (!extracted.ok) {
    ctx.stderr.write(`${extracted.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (!extracted.driveId) {
    ctx.stderr.write('Usage: pagespace pages tree --drive <driveId> [parentId]\n');
    return EXIT_USAGE_ERROR;
  }
  const [parentId] = extracted.rest;
  const driveId = extracted.driveId;

  const recursive = await callSdk(ctx.stderr, () => ctx.sdk.pages.list({ driveId, parentId, recursive: true, ls: true }));
  if (!recursive.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(recursive.value)}\n`);
    return EXIT_SUCCESS;
  }

  const direct = await callSdk(ctx.stderr, () => ctx.sdk.pages.list({ driveId, parentId, recursive: false, ls: true }));
  if (!direct.ok) return EXIT_RUNTIME_ERROR;

  const rootIds = new Set(direct.value.pages.map((page) => page.id));
  ctx.stdout.write(renderPagesTree(recursive.value, rootIds));
  return EXIT_SUCCESS;
};

export const pagesReadDetailsHandler: CommandHandler = async (ctx, intent) => {
  const [pageId] = intent.args;
  if (!pageId) {
    ctx.stderr.write('Usage: pagespace pages read-details <pageId>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.pages.details({ pageId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    const page = result.value;
    ctx.stdout.write(`${page.type}  ${page.id}  ${page.title ?? '(untitled)'}\n`);
    ctx.stdout.write(`Children: ${page.children.length}, Messages: ${page.messages.length}\n`);
  }
  return EXIT_SUCCESS;
};

export const pagesCreateHandler: CommandHandler = async (ctx, intent) => {
  const extracted = extractDriveFlag(intent.args);
  if (!extracted.ok) {
    ctx.stderr.write(`${extracted.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const usage = 'Usage: pagespace pages create <title> <type> [parentId] --drive <driveId>\n';
  if (!extracted.driveId) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }
  const [title, rawType, parentId] = extracted.rest;
  if (!title || !rawType) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const parsedType = pageTypeSchema.safeParse(rawType);
  if (!parsedType.success) {
    ctx.stderr.write(`Invalid page type "${rawType}". Expected one of: ${pageTypeSchema.options.join(', ')}\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.pages.create({ driveId: extracted.driveId as string, title, type: parsedType.data, parentId: parentId ?? null }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Created page ${renderPage(result.value)}`);
  }
  return EXIT_SUCCESS;
};

export const pagesRenameHandler: CommandHandler = async (ctx, intent) => {
  const [pageId, title] = intent.args;
  if (!pageId || !title || intent.args.length > 2) {
    ctx.stderr.write('Usage: pagespace pages rename <pageId> <title>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.pages.rename({ pageId, title }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Renamed page ${renderPage(result.value)}`);
  }
  return EXIT_SUCCESS;
};

/** Literal keyword for "move to drive root" — a leading `-` would be misparsed as a flag by `parseArgv`. */
const ROOT_PARENT_KEYWORD = 'root';

export const pagesMoveHandler: CommandHandler = async (ctx, intent) => {
  const [pageId, rawNewParentId, rawNewPosition] = intent.args;
  if (!pageId || rawNewParentId === undefined || rawNewPosition === undefined) {
    ctx.stderr.write(`Usage: pagespace pages move <pageId> <newParentId|${ROOT_PARENT_KEYWORD}> <newPosition>\n`);
    return EXIT_USAGE_ERROR;
  }

  const newPosition = Number(rawNewPosition);
  if (!Number.isFinite(newPosition)) {
    ctx.stderr.write(`Invalid newPosition "${rawNewPosition}": must be a finite number.\n`);
    return EXIT_USAGE_ERROR;
  }

  const newParentId = rawNewParentId === ROOT_PARENT_KEYWORD ? null : rawNewParentId;
  const result = await callSdk(ctx.stderr, () => ctx.sdk.pages.move({ pageId, newParentId, newPosition }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`${result.value.message}\n`);
  }
  return EXIT_SUCCESS;
};

export const pagesTrashHandler: CommandHandler = async (ctx, intent) => {
  const [pageId] = intent.args;
  if (!pageId) {
    ctx.stderr.write('Usage: pagespace pages trash <pageId> [--all] [--yes]\n');
    return EXIT_USAGE_ERROR;
  }
  const trashChildren = intent.flags.all;

  const confirmation = await confirmDestructive(
    `Trash page ${pageId}${trashChildren ? ' and all its children' : ''}? [y/N] `,
    { isTTY: ctx.isTTY, yes: intent.flags.yes, prompt: ctx.prompt },
  );
  if (!confirmation.ok) {
    ctx.stderr.write(`${confirmationFailureMessage(confirmation)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.pages.trash({ pageId, trash_children: trashChildren }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`${result.value.message}\n`);
  }
  return EXIT_SUCCESS;
};

export const pagesRestoreHandler: CommandHandler = async (ctx, intent) => {
  const [pageId] = intent.args;
  if (!pageId) {
    ctx.stderr.write('Usage: pagespace pages restore <pageId>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.pages.restore({ pageId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`${result.value.message}\n`);
  }
  return EXIT_SUCCESS;
};
