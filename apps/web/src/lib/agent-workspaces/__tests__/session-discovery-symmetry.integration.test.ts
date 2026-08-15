/**
 * Discovery symmetry + shared-metadata visibility (epic Phase 2), against a
 * REAL migration-built Postgres.
 *
 * NOTE ON A REVERSAL. This file was written when the tool surface redacted
 * other members' private-thread titles, and its name still says "redaction".
 * The cross-member reach change removed that redaction from the TOOL listing
 * (not from the shared rule, which still serves the HTTP/sidebar surface and is
 * pinned below): once every listed worker is addressable by send/read/
 * kill_session, hiding the label leaves an agent unable to choose between ids it
 * is allowed to use.
 *
 * PR #2336 flagged (deliberately out of scope there): `list_sessions`' cross-
 * workspace listing was scoped to workspaces the caller OWNS, while
 * `spawn_session`'s explicit-`workspaceId` path (correctly) also admits drive
 * MEMBERS into a shared workspace — so a member could target a shared
 * workspace by id but never learn the id from `list_sessions`. Restored here:
 * discovery (`listSharedWorkspaces`) and the spawn gate (`checkSessionAccess`
 * → `decideAgentSessionAccess`) are the same one decision, proven by
 * exercising BOTH against the same real rows:
 *
 *  1. a drive MEMBER discovers another member's shared-drive workspace AND
 *     can spawn into it;
 *  2. a NON-member gets neither — the workspace is absent from their listing
 *     and its id reads as nonexistent to the spawn;
 *  3. the shared listing redacts other members' private-thread titles to
 *     `(private thread)` while keeping the rows (honest count, agent +
 *     activity preserved), the member's own and deliberately-shared titles
 *     intact — and the workspace's OWNER keeps seeing everything in their
 *     own workspace, unredacted.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable — a silent skip
 * would be a green, zero-assertion pass. Local runs without Docker opt out
 * explicitly with ALLOW_SKIP_DB_TESTS=1.
 * Mirrors the other integration tests in this directory.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaceNodes } from '@pagespace/db/schema/agent-workspace-nodes';
import { factories } from '@pagespace/db/test/factories';
import { PRIVATE_THREAD_REDACTION, redactConversationTitleForViewer } from '@pagespace/lib/agent-workspaces/redact-conversation-listing';
import { resolveOrCreateConversation } from '@/lib/repositories/resolve-or-create-conversation';
import { buildSessionToolsDeps } from '@/lib/ai/tools/session-tools-runtime';
import { createConversationInSession, spawnSession } from '../agent-workspaces-runtime';
import { requireDb } from '@pagespace/db/test/require-db';

let dbAvailable = false;

describe('discovery symmetry + shared-metadata redaction (issue #2262 finding 6, PR #2336 follow-up)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('session-discovery-symmetry.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  it('a drive member DISCOVERS another member\'s shared workspace, sees redacted titles honestly, and can SPAWN into it; a non-member gets neither', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const member = await factories.createUser();
    const stranger = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createDriveMember(drive.id, member.id);

    // The OWNER's drive-scoped workspace, hosting three threads: the owner's
    // private one, the owner's deliberately shared one, and the member's own.
    const spawned = await spawnSession({ userId: owner.id, driveId: drive.id, name: 'team workspace' });
    if (!spawned.ok) throw new Error(`spawnSession failed: ${spawned.reason}`);
    const workspaceId = spawned.session.id;

    const ownerPrivateId = createId();
    await createConversationInSession({
      conversationId: ownerPrivateId,
      userId: owner.id,
      agentPageId: null,
      workspaceId: workspaceId,
      title: 'owner secret plans',
    });
    const ownerSharedId = createId();
    await createConversationInSession({
      conversationId: ownerSharedId,
      userId: owner.id,
      agentPageId: null,
      workspaceId: workspaceId,
      title: 'team notes',
    });
    await db.update(conversations).set({ isShared: true }).where(eq(conversations.id, ownerSharedId));
    const memberThreadId = createId();
    await createConversationInSession({
      conversationId: memberThreadId,
      userId: member.id,
      agentPageId: null,
      workspaceId: workspaceId,
      title: 'member research',
    });

    const deps = buildSessionToolsDeps();

    // 1. DISCOVERY — the member's shared listing carries the workspace…
    const memberShared = await deps.listSharedWorkspaces({ userId: member.id });
    const listed = memberShared.find((w) => w.workspaceId === workspaceId);
    expect(listed).toBeDefined();
    if (!listed) return;
    expect(listed.driveId).toBe(drive.id);

    // …with an HONEST worker count and REAL titles. This used to assert
    // `PRIVATE_THREAD_REDACTION` for the owner's private thread; the reach
    // widening removed that, because every row here is now addressable by
    // send/read/kill_session and a member cannot choose between several
    // identical "(private thread)" labels. The redaction rule itself is intact
    // and still governs the HTTP/sidebar listing — pinned below.
    expect(listed.workers).toHaveLength(3);
    const titleById = new Map(listed.workers.map((w) => [w.sessionId, w.name]));
    expect(titleById.get(memberThreadId)).toBe('member research');
    expect(titleById.get(ownerSharedId)).toBe('team notes');
    expect(titleById.get(ownerPrivateId)).toBe('owner secret plans');
    // The rule still exists and still redacts — it just no longer stands
    // between an agent and an id it is allowed to address.
    expect(
      redactConversationTitleForViewer({
        viewerId: member.id,
        workspaceOwnerId: owner.id,
        conversation: { ownerId: owner.id, isShared: false, title: 'owner secret plans' },
      }),
    ).toBe(PRIVATE_THREAD_REDACTION);

    // 2. SYMMETRY — the id the listing surfaced is spawnable-into, through
    // the same gate the explicit-workspaceId path always enforced.
    const memberCallerId = createId();
    await resolveOrCreateConversation(member.id, memberCallerId);
    const memberWorkerId = createId();
    const spawnedInto = await deps.createWorkerSession({
      conversationId: memberWorkerId,
      callerConversationId: memberCallerId,
      ownerId: member.id,
      agentPageId: null,
      name: 'member worker',
      workspace: workspaceId,
    });
    expect(spawnedInto).toEqual({ ok: true, workspaceId });
    // MEMBERSHIP IS THE NODE. This asserted `conversations.workspaceId`, which
    // nothing writes since membership moved to the tree — so it compared two
    // nulls and passed for no reason.
    const [memberWorkerNode] = await db
      .select({ rootId: agentWorkspaceNodes.rootId })
      .from(agentWorkspaceNodes)
      .where(
        and(eq(agentWorkspaceNodes.targetKind, 'chat'), eq(agentWorkspaceNodes.targetId, memberWorkerId)),
      )
      .limit(1);
    expect(memberWorkerNode?.rootId).toBe(workspaceId);

    // 3. The workspace's OWNER sees everything in their own workspace,
    // unchanged — including the member's thread title. (Their shared listing
    // does NOT re-list their own workspace: that is the own set's job.)
    const ownerDetail = await deps.listWorkspaceWorkers({
      workspaceId,
      callerConversationId: ownerPrivateId,
    });
    const ownerTitles = new Map(ownerDetail.workers.map((w) => [w.sessionId, w.name]));
    expect(ownerTitles.get(ownerPrivateId)).toBe('owner secret plans');
    expect(ownerTitles.get(memberThreadId)).toBe('member research');
    const ownerSharedListing = await deps.listSharedWorkspaces({ userId: owner.id });
    expect(ownerSharedListing.find((w) => w.workspaceId === workspaceId)).toBeUndefined();

    // 4. A NON-member's workspace appears in NEITHER: absent from discovery,
    // and its id reads as nonexistent to the spawn — the same one decision
    // refusing both.
    const strangerShared = await deps.listSharedWorkspaces({ userId: stranger.id });
    expect(strangerShared.find((w) => w.workspaceId === workspaceId)).toBeUndefined();
    const strangerCallerId = createId();
    await resolveOrCreateConversation(stranger.id, strangerCallerId);
    const refused = await deps.createWorkerSession({
      conversationId: createId(),
      callerConversationId: strangerCallerId,
      ownerId: stranger.id,
      agentPageId: null,
      name: 'trespasser',
      workspace: workspaceId,
    });
    expect(refused).toMatchObject({ ok: false, reason: 'workspace_not_found' });
  });
});
