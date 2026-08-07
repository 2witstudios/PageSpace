/**
 * UNDO BUMPS THE REV IN THE SAME TRANSACTION AS ITS WRITE.
 *
 * Epic "Agent-Session Single Source of Truth", spec §3 clause 2. Undo is a
 * durable message write — it soft-deletes a whole RANGE of messages, in
 * response to a click, in a pane the user is by definition looking at. So it
 * owes the same contract as every other write in `message-repository.ts`:
 *
 *     write + `UPDATE conversations SET rev = rev + 1 RETURNING rev`
 *     in ONE transaction; emit AFTER commit.
 *
 * ── WHAT THIS PINS, AND WHY IT MATTERS ─────────────────────────────────────
 * The bump is not a nicety layered on top of the emit; it is the FALLBACK FOR
 * the emit. `syncWatchedConversationRevs` compares revs and nothing else: on
 * reconnect, refocus or poll, a client asks "is my rev still the server's
 * rev?" and refetches when it is not. That is the only self-healing path in
 * the system.
 *
 * Which means an emit that fails is survivable — the rev moved, the client
 * notices on its next sync, the pane heals. A BUMP that fails is not: the
 * server and the client agree on a rev that no longer describes the data, so
 * the client has nothing to notice. The pane is stale until a manual reload,
 * forever.
 *
 * Undo previously bumped from a fire-and-forget `void (async () => ...)` in
 * the route, AFTER the write transaction had already committed, in a SEPARATE
 * transaction, under a `catch` that logged and swallowed. Every one of those
 * three properties independently converts a transient database or broadcast
 * hiccup into permanent, silent staleness.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';

vi.mock('@/lib/websocket/conversation-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/websocket/conversation-events')>();
  return {
    ...actual,
    conversationEvents: {
      created: vi.fn().mockResolvedValue(undefined),
      updated: vi.fn().mockResolvedValue(undefined),
      messageCreated: vi.fn().mockResolvedValue(undefined),
      messageUpdated: vi.fn().mockResolvedValue(undefined),
      messageDeleted: vi.fn().mockResolvedValue(undefined),
      undoApplied: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastAiMessageEdited: vi.fn().mockResolvedValue(undefined),
  broadcastAiMessageDeleted: vi.fn().mockResolvedValue(undefined),
  broadcastAiUndoApplied: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { previewAiUndo, executeAiUndo } from '@/services/api/ai-undo-service';
import { messageRepository } from '@/lib/repositories/message-repository';
import { broadcastAiUndoApplied } from '@/lib/websocket/socket-utils';
import { conversationEvents } from '@/lib/websocket/conversation-events';

let dbAvailable = false;

async function seedThread(count = 4) {
  const owner = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  const page = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });
  const conversationId = createId();
  const base = Date.now();

  await db.insert(conversations).values({
    id: conversationId,
    userId: owner.id,
    type: 'page',
    contextId: page.id,
    isActive: true,
    lastMessageAt: new Date(base + (count - 1) * 1000),
    updatedAt: new Date(),
  });

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = createId();
    await db.insert(messages).values({
      id,
      conversationId,
      userId: i % 2 === 0 ? owner.id : null,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
      isActive: true,
      status: 'complete' as const,
      createdAt: new Date(base + i * 1000),
    });
    ids.push(id);
  }
  return { ownerId: owner.id, pageId: page.id, conversationId, ids };
}

const revOf = async (conversationId: string): Promise<number> => {
  const [row] = await db
    .select({ rev: conversations.rev })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row.rev;
};

const activeCount = async (conversationId: string): Promise<number> => {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.isActive, true)));
  return rows.length;
};

describe('undo rev atomicity', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('executeAiUndo bumps the conversation rev in the same transaction as the soft-delete', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const thread = await seedThread();
    const revBefore = await revOf(thread.conversationId);

    const preview = await previewAiUndo(thread.ids[2], thread.ownerId);
    const result = await executeAiUndo(thread.ids[2], thread.ownerId, 'messages_only', preview!);
    expect(result.success).toBe(true);

    // The write landed…
    expect(await activeCount(thread.conversationId)).toBe(2);
    // …and the rev moved WITH it, without any help from the route. This is the
    // whole invariant: the write and the bump are one transaction, owned by
    // the writer, not a follow-up the caller may or may not perform.
    expect(await revOf(thread.conversationId)).toBe(revBefore + 1);
  });

  it('a throwing emit does not cost the rev bump — the client can still detect staleness', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const thread = await seedThread();
    const revBefore = await revOf(thread.conversationId);

    // The realtime service is down / the socket POST times out.
    vi.mocked(broadcastAiUndoApplied).mockRejectedValueOnce(new Error('realtime unreachable'));
    vi.mocked(conversationEvents.undoApplied).mockRejectedValueOnce(new Error('realtime unreachable'));

    const preview = await previewAiUndo(thread.ids[2], thread.ownerId);
    const result = await executeAiUndo(thread.ids[2], thread.ownerId, 'messages_only', preview!);

    // The undo itself still succeeds — a broadcast is not part of the write's
    // success condition.
    expect(result.success).toBe(true);
    expect(await activeCount(thread.conversationId)).toBe(2);

    // And critically: the rev moved anyway. A pane that missed the event will
    // see rev N+1 on its next sync, mismatch its own N, and refetch. Had the
    // bump been coupled to the emit, this conversation would read as
    // "unchanged" forever despite two deleted messages.
    expect(await revOf(thread.conversationId)).toBe(revBefore + 1);

    vi.mocked(broadcastAiUndoApplied).mockResolvedValue(undefined);
    vi.mocked(conversationEvents.undoApplied).mockResolvedValue(undefined);
  });

  it('an aborted undo takes the rev bump with it (no event for an uncommitted write)', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const thread = await seedThread();
    const revBefore = await revOf(thread.conversationId);

    // Same transaction cuts both ways: if the write rolls back, so must the
    // bump, or clients refetch to find nothing changed.
    await expect(
      db.transaction(async (tx) => {
        await messageRepository.softDeleteUndoRange(tx, {
          conversationId: thread.conversationId,
          fromCreatedAt: new Date(0),
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await revOf(thread.conversationId)).toBe(revBefore);
    expect(await activeCount(thread.conversationId)).toBe(4);
  });

  it('an idempotent re-undo neither writes nor bumps', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const thread = await seedThread();

    const preview = await previewAiUndo(thread.ids[2], thread.ownerId);
    await executeAiUndo(thread.ids[2], thread.ownerId, 'messages_only', preview!);
    const revAfterFirst = await revOf(thread.conversationId);

    // The already-inactive short-circuit returns success with zero counts; it
    // must not spend a rev on a no-op, or every double-click would invalidate
    // every watching pane for nothing.
    const again = await executeAiUndo(thread.ids[2], thread.ownerId, 'messages_only');
    expect(again.success).toBe(true);
    expect(await revOf(thread.conversationId)).toBe(revAfterFirst);
  });
});
