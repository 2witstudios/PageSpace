/**
 * Imago agent provisioning.
 *
 * Puts the registry's agent (`builtin-agents.ts` — one, `imago`, since owner
 * decision 2026-10-06) into the user's Home drive as an ordinary AI_CHAT page
 * under an `Imago` folder, and records which page is which key in
 * `user_builtin_agents`. Safe to call on every sign-in: a key whose page is
 * alive is left alone; a key whose page was deleted (the pointer cascaded
 * away) or trashed gets a fresh page and its pointer repointed.
 *
 * Every call also brings an existing user up to the current model, idempotently
 * (IMG-10.10): the live Imago page acts with the user's reach
 * (`userScopedAccess`), the retired Planner and Researcher pages are trashed
 * with their pointers dropped, and the drive grants the earlier model made for
 * any of the user's Imago pages are removed (`removeImagoDriveGrants`).
 *
 * Pages are created with the same invariants as the page service's
 * `createPage` (apps/web `pageService.createPage`): revision 0 with a state
 * hash, `createdBy`, the user's provider/model pair (else the product
 * default), the agent's MEMBER membership in its own drive (the native
 * membership every agent page has) and a `create` activity entry. That service lives in apps/web and opens its own transaction, so it
 * cannot run inside the provisioning transaction that holds the user-row lock;
 * this module mirrors its insert path instead. Page content is the AI_CHAT
 * default (no messages), so no page version is written, as with the other
 * provisioned pages (memory pages, starter skills, drive seeding).
 *
 * Activity entries are returned, not written: the activity hash chain has one
 * global advisory lock held until commit, so the caller writes them with
 * `writeImagoAgentActivity` as its transaction's last step. Written here, the
 * lock would cover the rest of the caller's work and serialise every
 * concurrent first sign-in behind it (and every other activity write).
 *
 * Race safety: the `FOR UPDATE` on the user row (the same row
 * `provisionHomeDriveIfNeeded`, `installStarterSkills` and
 * `provisionMemoryPages` lock) serialises concurrent provisioners; the unique
 * (userId, key) index is the backstop.
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq, inArray, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { createId } from '@paralleldrive/cuid2';
import { DEFAULT_AI_MODEL, DEFAULT_AI_PROVIDER } from '../ai/model-defaults';
import { detectPageContentFormat } from '../content/page-content-format';
import { getDefaultContent } from '../content/page-types.config';
import { createChangeGroupId } from '../monitoring/change-group';
import {
  getActorInfo,
  logActivityWithTx,
  type ActivityLogInput,
  type DeferredWorkflowTrigger,
} from '../monitoring/activity-logger';
import { computePageStateHash } from '../services/page-version-service';
import { hashWithPrefix } from '../utils/hash-utils';
import { PageType } from '../utils/enums';
import {
  BUILTIN_AGENTS,
  RETIRED_BUILTIN_AGENT_KEYS,
  type BuiltinAgentDefinition,
  type BuiltinAgentKey,
} from './builtin-agents';
import { lockImagoUser, removeImagoDriveGrants } from './imago-reach';

export const IMAGO_FOLDER_TITLE = 'Imago';

type DatabaseType = typeof db;
/** An OPEN transaction: the user-row lock only serialises while one is held. */
type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ProvisionImagoAgentsResult {
  homeDriveId: string;
  /** The live `Imago` folder; null only when every agent is alive and the folder is gone. */
  folderId: string | null;
  /** Live page id per key after provisioning. */
  agents: Record<BuiltinAgentKey, string>;
  /** Keys whose page this call created (empty when everything was already there). */
  created: BuiltinAgentKey[];
  /** The trashed pages the created ones replace (their pointers were repointed). */
  replacedPageIds: string[];
  /** Retired agents' pages (Planner, Researcher) this call trashed; their pointers are gone. */
  retiredPageIds: string[];
  /** Live agent pages this call switched to the user's reach (`userScopedAccess`). */
  reconciledPageIds: string[];
  /** Drive grants of the user's Imago pages this call removed. */
  removedGrants: number;
}

export interface ProvisionImagoAgentsInTransactionResult extends ProvisionImagoAgentsResult {
  /**
   * The created pages' `create` activity, not yet written. Write it with
   * `writeImagoAgentActivity` as the transaction's last step.
   */
  pendingActivity: ActivityLogInput[];
}

/**
 * Provision the Imago agents in the user's existing Home drive, in its own
 * transaction. Throws when the user has no Home drive: provisioning the drive
 * is `provisionHomeDriveIfNeeded`'s job, which calls this after its own
 * transaction commits, so Home never depends on the agents.
 */
export async function provisionImagoAgents(
  userId: string,
  client: DatabaseType = db,
): Promise<ProvisionImagoAgentsResult> {
  const { deferredTriggers, ...result } = await client.transaction(async (tx: TransactionType) => {
    await lockImagoUser(tx, userId);
    const [home] = await tx
      .select({ id: drives.id })
      .from(drives)
      .where(and(eq(drives.ownerId, userId), eq(drives.kind, 'HOME')))
      .limit(1);
    if (!home) throw new Error(`Cannot provision Imago agents: user ${userId} has no Home drive`);
    const { pendingActivity, ...provisioned } = await provisionImagoAgentsInTransaction(tx, userId, home.id);
    return { ...provisioned, deferredTriggers: await writeImagoAgentActivity(tx, pendingActivity) };
  });
  for (const trigger of deferredTriggers) trigger();
  return result;
}

/**
 * Provision the Imago agents inside a caller's transaction
 * (`provisionImagoAgents`, the backfill). Takes the user-row lock itself, so it is correct
 * even when the caller has not; re-taking a lock the transaction holds is free.
 */
export async function provisionImagoAgentsInTransaction(
  tx: TransactionType,
  userId: string,
  homeDriveId: string,
): Promise<ProvisionImagoAgentsInTransactionResult> {
  await lockImagoUser(tx, userId);

  const allPointers = await tx
    .select({ key: userBuiltinAgents.key, pageId: userBuiltinAgents.pageId })
    .from(userBuiltinAgents)
    .where(eq(userBuiltinAgents.userId, userId));
  const retiredKeys: readonly string[] = RETIRED_BUILTIN_AGENT_KEYS;
  const retiredPointers = allPointers.filter((pointer) => retiredKeys.includes(pointer.key));
  const pointers = allPointers.filter((pointer) => !retiredKeys.includes(pointer.key));

  const pointerIds = pointers.map((pointer) => pointer.pageId);
  const livePages = pointerIds.length === 0
    ? []
    : await tx
      .select({ id: pages.id })
      .from(pages)
      .where(and(inArray(pages.id, pointerIds), eq(pages.isTrashed, false)));
  const liveIds = new Set(livePages.map((page) => page.id));

  const agents: Partial<Record<BuiltinAgentKey, string>> = {};
  const missing: BuiltinAgentDefinition[] = [];
  const replacedPageIds: string[] = [];
  for (const definition of BUILTIN_AGENTS) {
    const pointer = pointers.find((candidate) => candidate.key === definition.key);
    if (pointer && liveIds.has(pointer.pageId)) agents[definition.key] = pointer.pageId;
    else {
      missing.push(definition);
      // A pointer still here means its page is trashed, not gone (deleting the
      // page cascades the pointer away).
      if (pointer) replacedPageIds.push(pointer.pageId);
    }
  }

  const creator = new PageCreator(tx, userId, homeDriveId);

  // Bring the live agents to the registry's reach: an agent provisioned before
  // IMG-10.10 still acts through drive memberships.
  const reconciledPageIds: string[] = [];
  for (const definition of BUILTIN_AGENTS) {
    const pageId = agents[definition.key];
    if (pageId && await creator.setUserScopedAccess(pageId, definition.userScopedAccess)) {
      reconciledPageIds.push(pageId);
    }
  }

  // The retired agents: trash what is still live (with everything under it)
  // and drop the pointers, so nothing reads them as built-in agents again.
  const retiredPageIds: string[] = [];
  for (const pointer of retiredPointers) retiredPageIds.push(...await creator.trashSubtree(pointer.pageId));
  if (retiredPointers.length > 0) {
    await tx
      .delete(userBuiltinAgents)
      .where(and(
        eq(userBuiltinAgents.userId, userId),
        inArray(userBuiltinAgents.key, retiredPointers.map((pointer) => pointer.key)),
      ));
  }
  // The folder is created only to hold a page being created: a user who moved
  // their agents out and deleted it does not get it back on every sign-in.
  const existingFolderId = await findImagoFolder(tx, homeDriveId);
  const folderId = existingFolderId ?? (missing.length > 0
    ? await creator.create({ title: IMAGO_FOLDER_TITLE, type: PageType.FOLDER, parentId: null })
    : null);

  for (const definition of missing) {
    const pageId = await creator.create({
      title: definition.title,
      type: PageType.AI_CHAT,
      parentId: folderId,
      agent: definition,
    });
    const now = new Date();
    await tx
      .insert(userBuiltinAgents)
      .values({ userId, key: definition.key, pageId, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [userBuiltinAgents.userId, userBuiltinAgents.key],
        set: { pageId, updatedAt: now },
      });
    agents[definition.key] = pageId;
  }
  // Imago acts with the user's reach, so a drive grant is moot — and one left
  // on a page no pointer names (replaced or retired) is a way into a drive.
  const removedGrants = await removeImagoDriveGrants(tx, [
    ...allPointers.map((pointer) => pointer.pageId),
    ...Object.values(agents),
  ]);

  return {
    homeDriveId,
    folderId,
    agents: agents as Record<BuiltinAgentKey, string>,
    created: missing.map((definition) => definition.key),
    replacedPageIds,
    retiredPageIds,
    reconciledPageIds,
    removedGrants,
    pendingActivity: creator.pendingActivity,
  };
}

/**
 * Write provisioning's pending activity inside `tx`. This takes the global
 * activity-chain lock until commit, so call it as the transaction's last step.
 * Returns the workflow triggers to fire once the transaction has committed.
 */
export async function writeImagoAgentActivity(
  tx: TransactionType,
  pendingActivity: ActivityLogInput[],
): Promise<DeferredWorkflowTrigger[]> {
  const triggers: DeferredWorkflowTrigger[] = [];
  for (const input of pendingActivity) {
    const trigger = await logActivityWithTx(input, tx);
    if (trigger) triggers.push(trigger);
  }
  return triggers;
}

/** The live root `Imago` folder in Home, if there is one. */
async function findImagoFolder(tx: TransactionType, homeDriveId: string): Promise<string | null> {
  const [existing] = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(and(
      eq(pages.driveId, homeDriveId),
      isNull(pages.parentId),
      eq(pages.title, IMAGO_FOLDER_TITLE),
      eq(pages.type, 'FOLDER'),
      eq(pages.isTrashed, false),
    ))
    .orderBy(pages.createdAt)
    .limit(1);
  return existing?.id ?? null;
}

interface CreatePageInput {
  title: string;
  type: PageType.FOLDER | PageType.AI_CHAT;
  parentId: string | null;
  agent?: BuiltinAgentDefinition;
}

/**
 * Inserts pages the way the page service's `createPage` does, inside `tx`,
 * collecting their activity in `pendingActivity` for the caller to write last.
 */
class PageCreator {
  readonly pendingActivity: ActivityLogInput[] = [];
  private actor: Promise<{ actorEmail: string; actorDisplayName?: string }> | null = null;
  private model: Promise<{ aiProvider: string; aiModel: string }> | null = null;
  private readonly changeGroupId = createChangeGroupId();

  constructor(
    private readonly tx: TransactionType,
    private readonly userId: string,
    private readonly driveId: string,
  ) {}

  async create(input: CreatePageInput): Promise<string> {
    const { tx, userId, driveId } = this;
    const [last] = await tx
      .select({ position: pages.position })
      .from(pages)
      .where(and(
        eq(pages.driveId, driveId),
        input.parentId ? eq(pages.parentId, input.parentId) : isNull(pages.parentId),
      ))
      .orderBy(desc(pages.position))
      .limit(1);
    const position = (last?.position ?? 0) + 1;

    const content = getDefaultContent(input.type);
    const contentFormat = detectPageContentFormat(content);
    const contentRef = hashWithPrefix(contentFormat, content);
    const agent = input.agent;
    const model = agent ? await this.resolveModel() : null;
    const enabledTools = agent ? [...agent.enabledTools] : null;

    const id = createId();
    const stateHash = computePageStateHash({
      title: input.title,
      contentRef,
      parentId: input.parentId,
      position,
      isTrashed: false,
      type: input.type,
      driveId,
      aiProvider: model?.aiProvider,
      aiModel: model?.aiModel,
      systemPrompt: agent?.systemPrompt,
      enabledTools,
      ...(agent && { userScopedAccess: agent.userScopedAccess }),
    });

    const now = new Date();
    await tx.insert(pages).values({
      id,
      title: input.title,
      type: input.type,
      parentId: input.parentId,
      driveId,
      content,
      contentMode: 'html',
      position,
      isTrashed: false,
      revision: 0,
      stateHash,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
      ...(agent && model && {
        aiProvider: model.aiProvider,
        aiModel: model.aiModel,
        systemPrompt: agent.systemPrompt,
        agentDefinition: agent.agentDefinition,
        enabledTools,
        includePageTree: agent.includePageTree,
        userScopedAccess: agent.userScopedAccess,
      }),
    });

    if (agent) {
      await tx.insert(driveAgentMembers).values({
        driveId,
        agentPageId: id,
        role: 'MEMBER',
        addedBy: userId,
      });
    }

    const actor = await this.resolveActor();
    this.pendingActivity.push({
      userId,
      actorEmail: actor.actorEmail,
      actorDisplayName: actor.actorDisplayName,
      operation: 'create',
      resourceType: 'page',
      resourceId: id,
      resourceTitle: input.title,
      driveId,
      pageId: id,
      contentRef,
      contentSize: Buffer.byteLength(content, 'utf8'),
      contentFormat,
      streamId: id,
      streamSeq: 0,
      changeGroupId: this.changeGroupId,
      changeGroupType: 'system',
      stateHashAfter: stateHash,
    });

    return id;
  }

  /**
   * Set `userScopedAccess` on a live agent page, the way the page service's
   * mutation path does (revision + 1, state hash, an `update` activity entry).
   * Returns whether the page changed.
   */
  async setUserScopedAccess(pageId: string, userScopedAccess: boolean): Promise<boolean> {
    const [page] = await this.tx.select().from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!page || page.userScopedAccess === userScopedAccess) return false;
    await this.mutate(page, 'update', { userScopedAccess });
    return true;
  }

  /**
   * Trash `rootId` and every live page under it, deepest first, the way the
   * page service's trash does per page. Returns the ids trashed (none when the
   * root is already trashed or gone).
   */
  async trashSubtree(rootId: string): Promise<string[]> {
    const { rows } = await this.tx.execute<{ id: string; depth: number }>(sql`
      WITH RECURSIVE subtree AS (
        SELECT ${pages.id} AS id, 0 AS depth FROM ${pages}
        WHERE ${pages.id} = ${rootId} AND ${pages.isTrashed} = false
        UNION ALL
        SELECT child."id", subtree.depth + 1 FROM "pages" child
        INNER JOIN subtree ON child."parentId" = subtree.id
        WHERE child."isTrashed" = false AND subtree.depth < 64
      )
      SELECT id, depth FROM subtree ORDER BY depth DESC`);
    const trashed: string[] = [];
    for (const { id } of rows) {
      const [page] = await this.tx.select().from(pages).where(eq(pages.id, id)).limit(1);
      if (!page) continue;
      await this.mutate(page, 'trash', { isTrashed: true, trashedAt: new Date() });
      trashed.push(id);
    }
    return trashed;
  }

  private async mutate(
    page: typeof pages.$inferSelect,
    operation: 'update' | 'trash',
    updates: Partial<Pick<typeof pages.$inferSelect, 'userScopedAccess' | 'isTrashed' | 'trashedAt'>>,
  ): Promise<void> {
    const content = page.content ?? '';
    const contentFormat = detectPageContentFormat(content);
    const contentRef = hashWithPrefix(contentFormat, content);
    const stateOf = (row: typeof pages.$inferSelect) => computePageStateHash({
      title: row.title,
      contentRef,
      parentId: row.parentId,
      position: row.position,
      isTrashed: row.isTrashed,
      type: row.type,
      driveId: row.driveId,
      aiProvider: row.aiProvider,
      aiModel: row.aiModel,
      systemPrompt: row.systemPrompt,
      enabledTools: row.enabledTools,
      isPaginated: row.isPaginated,
      includeDrivePrompt: row.includeDrivePrompt,
      agentDefinition: row.agentDefinition,
      visibleToGlobalAssistant: row.visibleToGlobalAssistant,
      includePageTree: row.includePageTree,
      pageTreeScope: row.pageTreeScope,
      toolExposureMode: row.toolExposureMode,
      userScopedAccess: row.userScopedAccess,
    });
    const stateHashBefore = stateOf(page);
    const stateHashAfter = stateOf({ ...page, ...updates });
    const revision = page.revision + 1;
    await this.tx
      .update(pages)
      .set({ ...updates, revision, stateHash: stateHashAfter, updatedAt: new Date() })
      .where(eq(pages.id, page.id));

    const fields = Object.keys(updates) as (keyof typeof updates)[];
    const actor = await this.resolveActor();
    this.pendingActivity.push({
      userId: this.userId,
      actorEmail: actor.actorEmail,
      actorDisplayName: actor.actorDisplayName,
      operation,
      resourceType: 'page',
      resourceId: page.id,
      resourceTitle: page.title,
      driveId: page.driveId,
      pageId: page.id,
      updatedFields: fields,
      previousValues: Object.fromEntries(fields.map((field) => [field, page[field]])),
      newValues: Object.fromEntries(fields.map((field) => [field, updates[field]])),
      streamId: page.id,
      streamSeq: revision,
      changeGroupId: this.changeGroupId,
      changeGroupType: 'system',
      stateHashBefore,
      stateHashAfter,
    });
  }

  private resolveActor() {
    // Through the transaction, never the global pool: this runs while the
    // transaction holds a connection and the user-row lock (see getActorInfo).
    this.actor ??= getActorInfo(this.userId, this.tx);
    return this.actor;
  }

  /** The user's provider+model as one pair, else the product default — never a mix. */
  private resolveModel() {
    this.model ??= this.tx
      .select({ provider: users.currentAiProvider, model: users.currentAiModel })
      .from(users)
      .where(eq(users.id, this.userId))
      .limit(1)
      .then(([user]) => (user?.provider && user.model
        ? { aiProvider: user.provider, aiModel: user.model }
        : { aiProvider: DEFAULT_AI_PROVIDER, aiModel: DEFAULT_AI_MODEL }));
    return this.model;
  }
}
