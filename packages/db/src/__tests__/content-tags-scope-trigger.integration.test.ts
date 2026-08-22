/**
 * The `content_tags_target_scope` trigger (migration 0270), against a real Postgres.
 *
 * The foreign keys added by 0268 prove only that each referenced row EXISTS. They
 * say nothing about whether the referenced rows belong TOGETHER, and three ways of
 * being incoherent survived them — each verified accepted against a migrated
 * database BEFORE the trigger was written, so these are regression pins on a
 * confirmed gap rather than speculation:
 *
 *   1. a tag from one drive assigned to a page in another, which steps straight
 *      over the boundary `UNIQUE (driveId, normalizedKey)` exists to draw;
 *   2. a `channel_message` target whose message is on a DIFFERENT page than the
 *      row's own `pageId`;
 *   3. an `ai_message` target whose conversation is not page-scoped to `pageId`.
 *
 * (2) and (3) are the sharp ones. `pageId` is denormalized onto every row so that
 * permission checks and the page-delete cascade work uniformly across kinds — so a
 * row whose `pageId` disagrees with its message is PERMISSIONED AGAINST THE WRONG
 * PAGE, readable by whoever can see the page it claims rather than the page its
 * content is actually on.
 *
 * Both directions are asserted throughout. A guard that refuses everything would
 * pass a refusal-only suite, and the five valid shapes below are exactly what
 * Phase 3's service has to be able to write.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { sql } from '../operators';
import { users } from '../schema/auth';
import { drives, pages, tags } from '../schema/core';
import { channelMessages } from '../schema/chat';
import { conversations, messages } from '../schema/conversations';
import { contentTags } from '../schema/content-tags';

/** Ids seeded once for the whole file; torn down by deleting the two roots. */
const id = {
  userA: createId(),
  driveA: createId(),
  driveB: createId(),
  docA: createId(),
  updateProbeDoc: createId(),
  docB: createId(),
  channelA: createId(),
  otherChannelA: createId(),
  aiChatA: createId(),
  tagA: createId(),
  tagB: createId(),
  messageOnChannelA: createId(),
  messageOnOtherChannelA: createId(),
  pageConversation: createId(),
  clientConversation: createId(),
  driveConversation: createId(),
  aiMessagePageScoped: createId(),
  aiMessageClientScoped: createId(),
  aiMessageDriveScoped: createId(),
};

const now = new Date();

beforeAll(async () => {
  await db.insert(users).values({ id: id.userA, name: 'Scope', email: `${id.userA}@example.com`, createdAt: now, updatedAt: now });
  await db.insert(drives).values([
    { id: id.driveA, name: 'A', slug: `a-${id.driveA}`, ownerId: id.userA, createdAt: now, updatedAt: now },
    { id: id.driveB, name: 'B', slug: `b-${id.driveB}`, ownerId: id.userA, createdAt: now, updatedAt: now },
  ]);
  await db.insert(pages).values([
    { id: id.docA, title: 'Doc in A', type: 'DOCUMENT', position: 1, driveId: id.driveA, createdAt: now, updatedAt: now },
    // A page used by ONE test only. Sharing `docA` with the accepts-block made
    // this suite order-coupled: the UPDATE probe below leaves its row behind if
    // its assertion throws, and the leftover then collides with the later
    // page-level insert through `content_tags_page_target_unique`. That turned a
    // single real failure into a cascade pointing at innocent tests.
    { id: id.updateProbeDoc, title: 'Update probe', type: 'DOCUMENT', position: 5, driveId: id.driveA, createdAt: now, updatedAt: now },
    { id: id.docB, title: 'Doc in B', type: 'DOCUMENT', position: 1, driveId: id.driveB, createdAt: now, updatedAt: now },
    { id: id.channelA, title: 'Channel in A', type: 'CHANNEL', position: 2, driveId: id.driveA, createdAt: now, updatedAt: now },
    { id: id.otherChannelA, title: 'Other channel in A', type: 'CHANNEL', position: 3, driveId: id.driveA, createdAt: now, updatedAt: now },
    { id: id.aiChatA, title: 'AI chat in A', type: 'AI_CHAT', position: 4, driveId: id.driveA, createdAt: now, updatedAt: now },
  ]);
  // The SAME normalized key in both drives — legal, and the reason the drive
  // check cannot be waved away as "the tag id already implies the drive".
  await db.insert(tags).values([
    { id: id.tagA, driveId: id.driveA, name: 'Risk', normalizedKey: 'risk', createdAt: now, updatedAt: now },
    { id: id.tagB, driveId: id.driveB, name: 'Risk', normalizedKey: 'risk', createdAt: now, updatedAt: now },
  ]);
  await db.insert(channelMessages).values([
    { id: id.messageOnChannelA, content: 'hi', createdAt: now, pageId: id.channelA, userId: id.userA },
    { id: id.messageOnOtherChannelA, content: 'yo', createdAt: now, pageId: id.otherChannelA, userId: id.userA },
  ]);
  await db.insert(conversations).values([
    { id: id.pageConversation, userId: id.userA, type: 'page', contextId: id.aiChatA, title: 'T', createdAt: now, updatedAt: now, lastMessageAt: now },
    { id: id.clientConversation, userId: id.userA, type: 'client', agentPageId: id.aiChatA, title: 'T', createdAt: now, updatedAt: now, lastMessageAt: now },
    { id: id.driveConversation, userId: id.userA, type: 'drive', contextId: id.driveA, title: 'T', createdAt: now, updatedAt: now, lastMessageAt: now },
  ]);
  await db.insert(messages).values([
    { id: id.aiMessagePageScoped, conversationId: id.pageConversation, role: 'user', content: 'hi', createdAt: now },
    { id: id.aiMessageClientScoped, conversationId: id.clientConversation, role: 'user', content: 'hi', createdAt: now },
    { id: id.aiMessageDriveScoped, conversationId: id.driveConversation, role: 'user', content: 'hi', createdAt: now },
  ]);
});

afterAll(async () => {
  // `content_tags`, `pages`, `tags` and the message tables all cascade from these
  // two roots, so deleting them takes every seeded row with it.
  await db.delete(drives).where(inArray(drives.id, [id.driveA, id.driveB]));
  await db.delete(users).where(inArray(users.id, [id.userA]));
});

type Assignment = Partial<typeof contentTags.$inferInsert> & { pageId: string; tagId: string };

function insert(row: Assignment) {
  return db.insert(contentTags).values({
    id: createId(),
    source: 'user',
    updatedAt: now,
    ...row,
  } as typeof contentTags.$inferInsert);
}

/** The trigger raises `check_violation` (23514); assert the CODE, not the prose. */
async function expectRefused(promise: Promise<unknown>, matching: RegExp) {
  await expect(promise).rejects.toThrow();
  await promise.catch((error: unknown) => {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause ?? (error as { code?: string; message?: string });
    expect(cause.code, 'trigger should raise SQLSTATE 23514 (check_violation)').toBe('23514');
    expect(cause.message ?? '').toMatch(matching);
  });
}

describe('content_tags_target_scope trigger — refuses incoherent assignments', () => {
  it('refuses a tag from another drive', async () => {
    await expectRefused(
      insert({ tagId: id.tagA, pageId: id.docB, targetKind: 'page' }),
      /is in drive .*, but page .* is in drive/,
    );
  });

  it('refuses a channel message that lives on a different page', async () => {
    await expectRefused(
      insert({ tagId: id.tagA, pageId: id.channelA, targetKind: 'channel_message', channelMessageId: id.messageOnOtherChannelA }),
      /channel message .* is on page .*, but the tag claims page/,
    );
  });

  it('refuses an AI message from a drive-scoped conversation', async () => {
    await expectRefused(
      insert({ tagId: id.tagA, pageId: id.aiChatA, targetKind: 'ai_message', aiMessageId: id.aiMessageDriveScoped }),
      /is not in a conversation scoped to page/,
    );
  });

  it('refuses an AI message whose conversation is scoped to a different page', async () => {
    await expectRefused(
      insert({ tagId: id.tagA, pageId: id.docA, targetKind: 'ai_message', aiMessageId: id.aiMessagePageScoped }),
      /is not in a conversation scoped to page/,
    );
  });

  it('refuses a dangling tag reference itself, rather than falling through to the FK', async () => {
    // A BEFORE trigger runs ahead of the foreign keys, so the scope lookups can
    // return NULL and the comparison must be NULL-safe (`IS DISTINCT FROM`, not
    // `<>`). With `<>` this branch falls through and the row is refused by the
    // FK as a 23503 instead — the row still never lands, so what this pins is
    // that the trigger's own logic is TOTAL and that the error names the drives
    // rather than being a bare key violation nobody can act on.
    await expectRefused(
      insert({ tagId: `missing_${createId()}`, pageId: id.docA, targetKind: 'page' }),
      /is in drive .*, but page .* is in drive/,
    );
  });

  it('fires on UPDATE too, not only INSERT', async () => {
    // The gap is reachable by moving an already-valid row, so a BEFORE INSERT
    // trigger alone would leave the whole class open through one UPDATE.
    const rowId = createId();
    await insert({ id: rowId, tagId: id.tagA, pageId: id.updateProbeDoc, targetKind: 'page' });
    // try/finally, so a failing assertion cannot skip the cleanup and strand a
    // row for the next test to trip over.
    try {
      await expectRefused(
        db.update(contentTags).set({ pageId: id.docB }).where(inArray(contentTags.id, [rowId])),
        /is in drive .*, but page .* is in drive/,
      );
    } finally {
      await db.delete(contentTags).where(inArray(contentTags.id, [rowId]));
    }
  });
});

describe('content_tags_target_scope trigger — accepts every coherent shape', () => {
  it('accepts a page tag inside its own drive', async () => {
    await expect(insert({ tagId: id.tagA, pageId: id.docA, targetKind: 'page' })).resolves.toBeDefined();
  });

  it('accepts each drive using the same tag NAME on its own pages', async () => {
    // `tagA` and `tagB` share `normalizedKey`; the trigger must separate them by
    // drive rather than by name, or the drive-scoped vocabulary is unusable.
    await expect(insert({ tagId: id.tagB, pageId: id.docB, targetKind: 'page' })).resolves.toBeDefined();
  });

  it('accepts a channel message tagged on its own page', async () => {
    await expect(
      insert({ tagId: id.tagA, pageId: id.channelA, targetKind: 'channel_message', channelMessageId: id.messageOnChannelA }),
    ).resolves.toBeDefined();
  });

  it('accepts an AI message in a type=page conversation', async () => {
    await expect(
      insert({ tagId: id.tagA, pageId: id.aiChatA, targetKind: 'ai_message', aiMessageId: id.aiMessagePageScoped }),
    ).resolves.toBeDefined();
  });

  it('accepts an AI message in a type=client conversation anchored by agentPageId', async () => {
    // The SECOND page-scope disjunct. Enforcing only the first would silently
    // lock every API-managed thread out of being tagged.
    await expect(
      insert({ tagId: id.tagA, pageId: id.aiChatA, targetKind: 'ai_message', aiMessageId: id.aiMessageClientScoped }),
    ).resolves.toBeDefined();
  });

  it('accepts an anchored text tag inside its own drive', async () => {
    await expect(
      insert({
        tagId: id.tagA,
        pageId: id.docA,
        targetKind: 'text',
        anchor: { v: 1, exact: 'quoted', prefix: '', suffix: '', start: 0, end: 6, revision: 1, textHash: 'deadbeefdeadbeef' },
        anchorStatus: 'exact',
        source: 'ai',
      }),
    ).resolves.toBeDefined();
  });
});

describe('content_tags_target_scope trigger — installation', () => {
  it('is installed on content_tags for INSERT and UPDATE', async () => {
    const result = await db.execute<{ tgname: string; timing: string; events: string }>(sql`
      SELECT t.tgname,
             CASE WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
             concat_ws(',',
               CASE WHEN (t.tgtype & 4)  <> 0 THEN 'INSERT' END,
               CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' END) AS events
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'content_tags' AND NOT t.tgisinternal
    `);
    expect(result.rows.map((r) => r.tgname)).toContain('content_tags_target_scope');
    const row = result.rows.find((r) => r.tgname === 'content_tags_target_scope')!;
    expect(row.timing).toBe('BEFORE');
    expect(row.events).toBe('INSERT,UPDATE');
  });

  it('pins search_path on the trigger function, and does NOT take SECURITY DEFINER', async () => {
    const result = await db.execute<{ proconfig: string[] | null; prosecdef: boolean }>(sql`
      SELECT proconfig, prosecdef FROM pg_proc WHERE proname = 'content_tags_enforce_target_scope'
    `);
    expect(result.rows).toHaveLength(1);
    expect(
      (result.rows[0].proconfig ?? []).some((entry) => entry.startsWith('search_path=')),
      'an unpinned search_path is a hijack in any function',
    ).toBe(true);
    // Unlike the reclaim triggers, this one only READS tables its caller can
    // already read. Gaining privilege would let it disclose the existence of
    // rows the caller cannot see, through an error message or timing.
    expect(result.rows[0].prosecdef, 'a validation trigger must not gain privilege').toBe(false);
  });
});
