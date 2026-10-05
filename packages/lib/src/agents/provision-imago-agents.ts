/**
 * Imago agent provisioning.
 *
 * Puts the registry's agents (`builtin-agents.ts`) into the user's Home drive
 * as ordinary AI_CHAT pages under an `Imago` folder, and records which page is
 * which key in `user_builtin_agents`. Safe to call on every sign-in: a key
 * whose page is alive is left alone; a key whose page was deleted (the pointer
 * cascaded away) or trashed gets a fresh page and its pointer repointed.
 *
 * Pages are created with the same invariants as the page service's
 * `createPage` (apps/web `pageService.createPage`): revision 0 with a state
 * hash, `createdBy`, the user's provider/model pair (else the product
 * default), the agent's MEMBER membership in its own drive — without which the
 * agent's tools cannot reach the drive it lives in — and a `create` activity
 * entry. That service lives in apps/web and opens its own transaction, so it
 * cannot run inside the provisioning transaction that holds the user-row lock;
 * this module mirrors its insert path instead. Page content is the AI_CHAT
 * default (no messages), so no page version is written, as with the other
 * provisioned pages (memory pages, starter skills, drive seeding).
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
  type DeferredWorkflowTrigger,
} from '../monitoring/activity-logger';
import { computePageStateHash } from '../services/page-version-service';
import { hashWithPrefix } from '../utils/hash-utils';
import { PageType } from '../utils/enums';
import { BUILTIN_AGENTS, type BuiltinAgentDefinition, type BuiltinAgentKey } from './builtin-agents';

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
}

export interface ProvisionImagoAgentsInTransactionResult extends ProvisionImagoAgentsResult {
  /** Workflow triggers for the created pages; fire them only after the transaction commits. */
  deferredTriggers: DeferredWorkflowTrigger[];
}

/**
 * Provision the Imago agents in the user's existing Home drive, in its own
 * transaction. Throws when the user has no Home drive: provisioning the drive
 * is `provisionHomeDriveIfNeeded`'s job, which calls this module itself.
 */
export async function provisionImagoAgents(
  userId: string,
  client: DatabaseType = db,
): Promise<ProvisionImagoAgentsResult> {
  const { deferredTriggers, ...result } = await client.transaction(async (tx: TransactionType) => {
    await lockUser(tx, userId);
    const [home] = await tx
      .select({ id: drives.id })
      .from(drives)
      .where(and(eq(drives.ownerId, userId), eq(drives.kind, 'HOME')))
      .limit(1);
    if (!home) throw new Error(`Cannot provision Imago agents: user ${userId} has no Home drive`);
    return provisionImagoAgentsInTransaction(tx, userId, home.id);
  });
  for (const trigger of deferredTriggers) trigger();
  return result;
}

/**
 * Provision the Imago agents inside a caller's transaction (the Home-drive
 * provisioning transaction). Takes the user-row lock itself, so it is correct
 * even when the caller has not; re-taking a lock the transaction holds is free.
 */
export async function provisionImagoAgentsInTransaction(
  tx: TransactionType,
  userId: string,
  homeDriveId: string,
): Promise<ProvisionImagoAgentsInTransactionResult> {
  await lockUser(tx, userId);

  const pointers = await tx
    .select({ key: userBuiltinAgents.key, pageId: userBuiltinAgents.pageId })
    .from(userBuiltinAgents)
    .where(eq(userBuiltinAgents.userId, userId));

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
  for (const definition of BUILTIN_AGENTS) {
    const pointer = pointers.find((candidate) => candidate.key === definition.key);
    if (pointer && liveIds.has(pointer.pageId)) agents[definition.key] = pointer.pageId;
    else missing.push(definition);
  }

  const creator = new PageCreator(tx, userId, homeDriveId);
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

  return {
    homeDriveId,
    folderId,
    agents: agents as Record<BuiltinAgentKey, string>,
    created: missing.map((definition) => definition.key),
    deferredTriggers: creator.deferredTriggers,
  };
}

async function lockUser(tx: TransactionType, userId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);
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

/** Inserts pages the way the page service's `createPage` does, inside `tx`. */
class PageCreator {
  readonly deferredTriggers: DeferredWorkflowTrigger[] = [];
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
    const trigger = await logActivityWithTx({
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
    }, tx);
    if (trigger) this.deferredTriggers.push(trigger);

    return id;
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
