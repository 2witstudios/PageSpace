/**
 * What an Imago turn knows about its own agent (IMG-4.7; reshaped by IMG-10.10).
 *
 * Imago replaces the Global Assistant one for one (owner decision 2026-10-06):
 * it acts with its owner's own reach, so its turn carries the Global
 * Assistant's context (`assistant-context.ts`) — with one difference, the
 * drives the user keeps Imago out of (`imago_drive_access` off). Those are
 * outside its reach like a drive the user cannot open: their tree, prompt and
 * drive-level integrations never reach the model, and when the user is looking
 * at one the LOCATION block says so, so "put this here" is answered honestly
 * instead of attempted and refused.
 *
 * "Imago agent" means the page is one of THIS user's `user_builtin_agents`
 * pointers. Anyone else's Imago agent gets nothing from here, and reaches
 * nothing at all (`actor-permissions.ts`).
 */

import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { imagoExcludedDriveIds } from '@pagespace/lib/agents/imago-reach';
import type { LocationContext } from '@/lib/ai/shared/chat-types';
import type { LocationAgentAccess } from './location-prompt';

export interface ImagoAgentContext {
  /** The drive the agent page lives in — the user's Home drive. */
  homeDriveId: string;
  /** The drives the user keeps Imago out of. */
  excludedDriveIds: ReadonlySet<string>;
}

/**
 * The Home drive `agentPageId` lives in when it is one of `userId`'s live
 * built-in agents, else null.
 */
export async function findOwnImagoHomeDriveId(userId: string, agentPageId: string): Promise<string | null> {
  const [pointer] = await db
    .select({ homeDriveId: pages.driveId })
    .from(userBuiltinAgents)
    .innerJoin(pages, eq(pages.id, userBuiltinAgents.pageId))
    .where(and(
      eq(userBuiltinAgents.userId, userId),
      eq(userBuiltinAgents.pageId, agentPageId),
      eq(pages.isTrashed, false),
    ))
    .limit(1);
  return pointer?.homeDriveId ?? null;
}

/** The Imago context for `agentPageId` when it is one of `userId`'s built-in agents, else `null`. */
export async function loadImagoAgentContext(input: {
  userId: string;
  agentPageId: string;
}): Promise<ImagoAgentContext | null> {
  const homeDriveId = await findOwnImagoHomeDriveId(input.userId, input.agentPageId);
  if (!homeDriveId) return null;
  return { homeDriveId, excludedDriveIds: await imagoExcludedDriveIds(input.userId) };
}

/**
 * The user whose built-in (Imago) agent `agentPageId` is, or null for any other
 * page. Unlike `loadImagoAgentContext` this answers for every user's agents, so
 * a caller can refuse to treat someone else's Imago agent as an ordinary one.
 */
export async function findBuiltinAgentOwner(agentPageId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: userBuiltinAgents.userId })
    .from(userBuiltinAgents)
    .where(eq(userBuiltinAgents.pageId, agentPageId))
    .limit(1);
  return row?.userId ?? null;
}

/** The LOCATION note for a drive in view the user keeps Imago out of; undefined anywhere else. */
export function resolveImagoLocationAccess(
  location: LocationContext | null,
  context: ImagoAgentContext,
): LocationAgentAccess | undefined {
  const driveId = location?.currentDrive?.id;
  return driveId && context.excludedDriveIds.has(driveId) ? { kind: 'excluded' } : undefined;
}

/**
 * The drive in view as Imago may use it — for drive-level context and
 * integrations — or null when none is in view or the user keeps Imago out of it.
 */
export function resolveImagoDriveInView(
  location: LocationContext | null,
  context: ImagoAgentContext,
): string | null {
  const driveId = location?.currentDrive?.id ?? null;
  return driveId && !context.excludedDriveIds.has(driveId) ? driveId : null;
}
