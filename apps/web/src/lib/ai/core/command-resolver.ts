/**
 * Command resolution for AI routes (Universal Commands phase 4).
 *
 * Turns the command token in a user message into an execution plan. The
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
import {
  findActiveCommandToken,
  type CommandExecutionPlan,
  type CommandChildResource,
  type ParsedCommandToken,
} from './command-processor';
import { serializePageContentForAI, isTextSerializablePageType } from './page-serializer';

/** DB command ids are cuid2-style lowercase alphanumerics. */
const COMMAND_ID_PATTERN = /^[a-z0-9]{10,40}$/;
/** Manifest cap — a pathological child count must not balloon the prompt. */
const MAX_MANIFEST_CHILDREN = 100;

/**
 * Where the message is being sent from, as far as commands care: the drive
 * the chat surface lives in. The global assistant has no drive — built-ins
 * then resolve against personal commands + built-ins only.
 */
export interface CommandResolutionContext {
  driveId?: string | null;
}

/**
 * Resolve the message's command token (if any) into an execution plan.
 * Returns null when the message carries no command, and also on unexpected
 * resolution errors — the chat request must proceed regardless.
 */
export async function planCommandExecution(
  content: string,
  senderId: string,
  context: CommandResolutionContext = {}
): Promise<CommandExecutionPlan | null> {
  const token = findActiveCommandToken(content);
  if (!token) return null;

  try {
    return await resolveToken(token, senderId, context);
  } catch (error) {
    loggers.ai.error('Command resolution failed; proceeding without injection', error as Error, {
      commandId: token.commandId,
    });
    return null;
  }
}

function skip(
  token: ParsedCommandToken,
  reason: 'page_trashed' | 'no_access' | 'not_found' | 'disabled'
): CommandExecutionPlan {
  return { kind: 'skip', commandId: token.commandId, label: token.label, reason };
}

async function resolveToken(
  token: ParsedCommandToken,
  senderId: string,
  context: CommandResolutionContext
): Promise<CommandExecutionPlan> {
  if (token.commandId.startsWith(BUILTIN_ID_PREFIX)) {
    return resolveBuiltin(token, senderId, context);
  }

  // Shape-validate the hostile id before any DB operation.
  if (!COMMAND_ID_PATTERN.test(token.commandId)) {
    return skip(token, 'not_found');
  }

  const command = await db.query.commands.findFirst({
    where: eq(commands.id, token.commandId),
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

  if (!command) return skip(token, 'not_found');

  // Usability gate first: a command the sender can't use must be
  // indistinguishable from a nonexistent one (no state probing).
  if (command.userId) {
    if (command.userId !== senderId) return skip(token, 'not_found');
  } else if (command.driveId) {
    const isMember = await isUserDriveMember(senderId, command.driveId);
    if (!isMember) return skip(token, 'not_found');
  } else {
    // Scope invariant violated (DB check constraint should prevent this).
    return skip(token, 'not_found');
  }

  if (!command.enabled) return skip(token, 'disabled');

  const entryPage = command.entryPage;
  if (!entryPage || entryPage.isTrashed) return skip(token, 'page_trashed');

  // Cross-drive / stale references are re-permission-checked on every use.
  const canView = await canUserViewPage(senderId, entryPage.id);
  if (!canView) return skip(token, 'no_access');

  const serializedContent = isTextSerializablePageType(entryPage.type)
    ? serializePageContentForAI(entryPage)
    : `(This entry page is a ${entryPage.type} page. Use read_page with pageId "${entryPage.id}" to read it.)`;

  const children = await loadViewableChildren(entryPage.id, senderId);

  return {
    kind: 'inject',
    injection: {
      commandId: command.id,
      trigger: command.trigger,
      label: token.label,
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
 * Built-ins have no entry page — their instruction is the description, plus
 * an optional dynamic section the registry declares as a pure function of
 * injected data. The data loading happens HERE (registry stays pure): for
 * /help that is the sender's precedence-resolved command list. A loading
 * failure degrades to the static description, never the request.
 */
async function resolveBuiltin(
  token: ParsedCommandToken,
  senderId: string,
  context: CommandResolutionContext
): Promise<CommandExecutionPlan> {
  const trigger = token.commandId.slice(BUILTIN_ID_PREFIX.length);
  const builtin = BUILTIN_COMMANDS.find((command) => command.trigger === trigger);
  if (!builtin) return skip(token, 'not_found');

  const dynamicContent = await loadBuiltinDynamicSection(builtin, senderId, context);

  return {
    kind: 'inject',
    injection: {
      commandId: token.commandId,
      trigger: builtin.trigger,
      label: token.label,
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
