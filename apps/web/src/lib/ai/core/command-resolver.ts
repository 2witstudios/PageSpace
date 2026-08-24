/**
 * Command resolution for AI routes (Universal Commands).
 *
 * Turns each command token in a user message into an execution plan. The
 * commandId arrives inside CLIENT-CONTROLLED message content and is treated
 * as hostile end to end:
 *
 *  - the id is shape-validated before it reaches any DB operation;
 *  - the command must be usable by the SENDER (personal commands only by
 *    their owner, drive commands only by members of that drive) — anything
 *    else resolves exactly like a nonexistent command so forged ids can't
 *    probe for existence;
 *  - entry-page access is re-checked at use time with canUserViewPage, so
 *    a stale or forged reference never leaks content;
 *  - every failure degrades (skip plan or null) — command resolution can
 *    never fail the chat request itself.
 */

import { db } from '@pagespace/db/db';
import { and, asc, eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { commands } from '@pagespace/db/schema/commands';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import {
  BUILTIN_COMMANDS,
  BUILTIN_ID_PREFIX,
  type BuiltinCommandDefinition,
} from '@pagespace/lib/commands/command-core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { loadAvailableCommands } from '@/lib/commands/available-commands';
import { getSkillBody } from '@/lib/ai/skills/skill-bodies';
import {
  findActiveCommandTokens,
  type CommandExecutionPlan,
  type CommandChildResource,
  type ParsedCommandToken,
} from './command-processor';
import { serializePageContentForAI, isTextSerializablePageType } from './page-serializer';
import { isSheetType } from '@pagespace/lib/sheets/sheet';
import {
  SheetDocumentUnreadableError,
  SheetTabNotFoundError,
  SHEET_PREVIEW_ROWS,
  loadSheetWindow,
  renderSheetTable,
} from '../tools/sheet-view';
import { PageType } from '@pagespace/lib/utils/enums';

/**
 * A SHEET entry page, rendered for injection.
 *
 * Bounded on purpose: this text is prompt, not a tool result, so its cost is
 * paid on every turn the command is active. It carries what a reader needs to
 * decide what to ASK for — the sheet's size, its tabs, and its first rows —
 * and names the tool that answers.
 *
 * Never throws. A command whose entry page cannot be parsed must still resolve;
 * refusing the whole command because one referenced sheet is damaged would take
 * away the tools needed to investigate it. The note says the sheet is unreadable
 * rather than empty, for the same reason every other caller does: an agent told
 * a sheet is blank may overwrite data that is still intact.
 */
async function serializeSheetForInjection(pageId: string, content: string | null): Promise<string> {
  try {
    const sheet = await loadSheetWindow(pageId, {
      limit: SHEET_PREVIEW_ROWS,
      documentContent: content,
    });
    const table = renderSheetTable(sheet.rows).text;
    const header =
      `(SHEET "${sheet.tabName}": ${sheet.rowCount} rows x ${sheet.columnCount} columns` +
      (sheet.tabs.length > 1 ? `, ${sheet.tabs.length} tabs` : '') + '.)';

    if (!table) {
      return `${header} No rows yet. Use read_sheet with pageId "${pageId}" once it has data.`;
    }
    return (
      `${header} First ${sheet.rows.length} row(s) below. ` +
      `Use read_sheet with pageId "${pageId}" to read a row range, filter rows by column value, ` +
      `or return only some columns — do not assume these rows are all of it.\n${table}`
    );
  } catch (error) {
    if (error instanceof SheetDocumentUnreadableError || error instanceof SheetTabNotFoundError) {
      return (
        `(SHEET could not be read: ${error.message} It is NOT empty — do not overwrite it. ` +
        `Use read_sheet with pageId "${pageId}" for the full error.)`
      );
    }
    throw error;
  }
}

/** DB command ids are cuid2-style lowercase alphanumerics. */
const COMMAND_ID_PATTERN = /^[a-z0-9]{10,40}$/;
/** Manifest cap — a pathological child count must not balloon the prompt. */
const MAX_MANIFEST_CHILDREN = 100;
/**
 * There is deliberately no cap on how many distinct commands one message may
 * chain (a product decision, not an oversight). This bounds CONCURRENCY
 * instead: a message with hundreds of hand-crafted/forged command tokens
 * must not fan out into hundreds of simultaneous DB round trips and exhaust
 * the connection pool for the whole app. Resolution still completes for
 * every token — this only limits how many run at once.
 */
const RESOLUTION_CONCURRENCY_LIMIT = 10;

/**
 * Run `fn` over every item with at most `limit` concurrent in-flight calls,
 * preserving input order in the returned array regardless of completion
 * order. Mirrors the pattern already used for backup export streaming
 * (apps/web/src/services/api/backup-export-service.ts), generalized to
 * return each call's value.
 */
async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  // Guard against a zero/negative limit spawning no workers and silently
  // returning an array of holes instead of running anything.
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Where the message is being sent from, as far as commands care: the drive
 * the chat surface lives in. The global assistant has no drive — built-ins
 * then resolve against personal commands + built-ins only.
 */
export interface CommandResolutionContext {
  driveId?: string | null;
}

/**
 * Resolve every command token in the message into execution plans,
 * independently — one invalid, permission-denied, or erroring command never
 * prevents the others from resolving. Returns an empty array when the
 * message carries no command. An unexpected resolution error for one
 * command omits just that command's plan (same degrade-to-nothing
 * philosophy as a single command's unexpected error) without affecting the
 * others — the chat request must proceed regardless.
 */
export async function planCommandExecutions(
  content: string,
  senderId: string,
  context: CommandResolutionContext = {}
): Promise<CommandExecutionPlan[]> {
  const tokens = findActiveCommandTokens(content);
  if (tokens.length === 0) return [];

  const results = await mapWithConcurrencyLimit(
    tokens,
    RESOLUTION_CONCURRENCY_LIMIT,
    async (token) => {
      try {
        return await resolveToken(token, senderId, context);
      } catch (error) {
        loggers.ai.error('Command resolution failed; proceeding without injection', error as Error, {
          commandId: token.commandId,
        });
        return null;
      }
    }
  );

  return results.filter((plan): plan is CommandExecutionPlan => plan !== null);
}

function skip(
  commandId: string,
  label: string,
  reason: 'page_trashed' | 'no_access' | 'not_found' | 'disabled'
): CommandExecutionPlan {
  return { kind: 'skip', commandId, label, reason };
}

async function resolveToken(
  token: ParsedCommandToken,
  senderId: string,
  context: CommandResolutionContext
): Promise<CommandExecutionPlan> {
  if (token.commandId.startsWith(BUILTIN_ID_PREFIX)) {
    const trigger = token.commandId.slice(BUILTIN_ID_PREFIX.length);
    return resolveBuiltinInjection(trigger, senderId, context, token.label);
  }

  return resolveCommandInjectionById(token.commandId, senderId, token.label);
}

/**
 * Resolve a user/drive command BY ID into an execution plan, applying the
 * full hostile-input pipeline: shape validation, sender-usability gate
 * (personal = owner only, drive = members only, both indistinguishable from
 * not_found), enabled check, entry-page trash check, use-time
 * canUserViewPage, serialization, and the viewable-children manifest.
 *
 * Shared by the chip path (resolveToken) and the model path (load_skill) so
 * both loads are permission-identical by construction. `label` is the chip's
 * display label; tool-initiated loads default it to the command id.
 */
export async function resolveCommandInjectionById(
  commandId: string,
  senderId: string,
  label: string = commandId
): Promise<CommandExecutionPlan> {
  // Shape-validate the hostile id before any DB operation.
  if (!COMMAND_ID_PATTERN.test(commandId)) {
    return skip(commandId, label, 'not_found');
  }

  const command = await db.query.commands.findFirst({
    where: eq(commands.id, commandId),
    with: {
      entryPage: {
        columns: {
          id: true,
          title: true,
          type: true,
          content: true,
          contentMode: true,
          isTrashed: true,
        },
      },
    },
  });

  if (!command) return skip(commandId, label, 'not_found');

  // Usability gate first: a command the sender can't use must be
  // indistinguishable from a nonexistent one (no state probing).
  if (command.userId) {
    if (command.userId !== senderId) return skip(commandId, label, 'not_found');
  } else if (command.driveId) {
    const isMember = await isUserDriveMember(senderId, command.driveId);
    if (!isMember) return skip(commandId, label, 'not_found');
  } else {
    // Scope invariant violated (DB check constraint should prevent this).
    return skip(commandId, label, 'not_found');
  }

  if (!command.enabled) return skip(commandId, label, 'disabled');

  const entryPage = command.entryPage;
  if (!entryPage || entryPage.isTrashed) return skip(commandId, label, 'page_trashed');

  // Cross-drive / stale references are re-permission-checked on every use.
  const canView = await canUserViewPage(senderId, entryPage.id);
  if (!canView) return skip(commandId, label, 'no_access');

  // A SHEET entry page is injected as rows, not as its stored document.
  //
  // Serialising the whole SheetDoc here was the same defect as `read_page`'s
  // (issue #2467) with a worse blast radius: an injection is not an on-demand
  // read, it rides the prompt on EVERY use of the command. A 500-row sheet
  // serialises to ~460KB, so what actually reached the model was
  // `COMMAND_CONTENT_CHAR_LIMIT` worth of TOML — a truncated header a few dozen
  // cells in, spending the command's whole content budget on markup. A sheet
  // used as a command resource is a reference table; its shape plus its first
  // rows plus a pointer to `read_sheet` is the useful form.
  const serializedContent = isSheetType(entryPage.type as PageType)
    ? await serializeSheetForInjection(entryPage.id, entryPage.content)
    : isTextSerializablePageType(entryPage.type)
      ? serializePageContentForAI(entryPage)
      : `(This entry page is a ${entryPage.type} page. Use read_page with pageId "${entryPage.id}" to read it.)`;

  const children = await loadViewableChildren(entryPage.id, senderId);

  return {
    kind: 'inject',
    injection: {
      commandId: command.id,
      trigger: command.trigger,
      label,
      scope: command.userId ? 'user' : 'drive',
      description: command.description,
      entryPage: {
        id: entryPage.id,
        title: entryPage.title,
        type: entryPage.type,
        serializedContent,
      },
      children,
    },
  };
}

/**
 * Built-ins have no entry page — their instruction is either a code-shipped
 * skill body (kind: 'skill') or the description plus an optional dynamic
 * section the registry declares as a pure function of injected data. The
 * data loading happens HERE (registry stays pure): for /help that is the
 * sender's precedence-resolved command list. A loading failure degrades to
 * the static description, never the request.
 *
 * Exported so the model path (load_skill) resolves built-ins through the
 * same function as the chip path. `label` defaults to the trigger for
 * tool-initiated loads.
 */
export async function resolveBuiltinInjection(
  trigger: string,
  senderId: string,
  context: CommandResolutionContext,
  label: string = trigger
): Promise<CommandExecutionPlan> {
  const commandId = `${BUILTIN_ID_PREFIX}${trigger}`;
  const builtin = BUILTIN_COMMANDS.find((command) => command.trigger === trigger);
  if (!builtin) return skip(commandId, label, 'not_found');

  const dynamicContent =
    builtin.kind === 'skill'
      ? (getSkillBody(builtin.trigger) ?? undefined)
      : await loadBuiltinDynamicSection(builtin, senderId, context);

  return {
    kind: 'inject',
    injection: {
      commandId,
      trigger: builtin.trigger,
      label,
      scope: 'builtin',
      description: builtin.description,
      entryPage: null,
      children: [],
      dynamicContent,
    },
  };
}

/**
 * Load the injected data for a built-in's dynamic prompt section and run the
 * pure builder over it. The context drive only counts when the sender is a
 * member (loadAvailableCommands requires membership-verified drive ids);
 * otherwise — and for the drive-less global assistant — the list is personal
 * commands + built-ins. Returns undefined (static-description fallback) on
 * any failure.
 */
async function loadBuiltinDynamicSection(
  builtin: BuiltinCommandDefinition,
  senderId: string,
  context: CommandResolutionContext
): Promise<string | undefined> {
  if (!builtin.buildPromptSection) return undefined;

  try {
    const requestedDriveId = context.driveId ?? null;
    const driveId =
      requestedDriveId && (await isUserDriveMember(senderId, requestedDriveId))
        ? requestedDriveId
        : null;
    const { winners } = await loadAvailableCommands(senderId, driveId);
    return builtin.buildPromptSection({ availableCommands: winners });
  } catch (error) {
    loggers.ai.error(
      'Built-in dynamic section failed; degrading to static description',
      error as Error,
      { trigger: builtin.trigger }
    );
    return undefined;
  }
}

/** Direct, non-trashed children of the entry page the sender can view. */
async function loadViewableChildren(
  entryPageId: string,
  senderId: string
): Promise<CommandChildResource[]> {
  const childRows = await db.query.pages.findMany({
    where: and(eq(pages.parentId, entryPageId), eq(pages.isTrashed, false)),
    columns: { id: true, title: true, type: true },
    orderBy: [asc(pages.position)],
    limit: MAX_MANIFEST_CHILDREN,
  });

  if (childRows.length === 0) return [];

  const viewChecks = await Promise.all(
    childRows.map(async (child) => ({
      child,
      canView: await canUserViewPage(senderId, child.id),
    }))
  );

  return viewChecks
    .filter((entry) => entry.canView)
    .map(({ child }) => ({ id: child.id, title: child.title, type: child.type }));
}
