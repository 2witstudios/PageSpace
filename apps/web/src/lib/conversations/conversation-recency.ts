/**
 * How a conversation listing decides RECENCY, and how it encodes a page
 * boundary. One declaration, imported by every history listing, because the
 * two that exist drifted apart and the drift was the bug.
 *
 * **Why this module exists.** The Agents surface's past-conversations listing
 * (`workspace-conversations-runtime.ts`) worked these out and documented each
 * one against the defect it fixes. The right sidebar's Conversation History
 * (`global-conversation-repository.ts`) never got them, and ordered by
 * `conversations.lastMessageAt` with a live-lookup cursor — which was invisible
 * for as long as that listing happened to contain only global-assistant
 * threads, every one of which carries the column. The message-table merge
 * (epic "Agent-Session Single Source of Truth", Phase 4 / D6) put page-agent
 * rows into `messages`, the sidebar's unfiltered `EXISTS(messages)` stopped
 * being an accidental type filter, and rows that never carry `lastMessageAt`
 * arrived in a listing sorted by it. Postgres orders `DESC` as NULLS FIRST, so
 * they landed at the TOP, tied, broken only by `id DESC` — arbitrary.
 *
 * Extracted rather than copied: two definitions of "newest first" is the state
 * that produced this, and a shared one cannot drift.
 */

import { desc, sql } from '@pagespace/db/operators';
import { conversations, messages } from '@pagespace/db/schema/conversations';

/**
 * The real "last activity" timestamp — NOT `conversations.lastMessageAt`,
 * which nothing ever sets for `type: 'page'`/`type: 'client'` conversations
 * (grepping every `.set({...lastMessageAt...})` call in this codebase turns up
 * exactly two call sites, both in the global-assistant message routes).
 * Sorting or displaying recency by `conversations.lastMessageAt` alone left
 * every page-agent conversation permanently ordered by its CREATION time,
 * however recently it was actually used (review finding).
 *
 * Reads the unified `messages` table since the merge (Phase 4 / D6).
 *
 * `GREATEST`, NOT `COALESCE` — the LATER of the two, not the message time with
 * the column as a fallback (review finding). A streaming placeholder is
 * inserted at stream START, and the write that completes it
 * (`saveGlobalMessageRow`) upserts on the message id with a `set` that does not
 * include `createdAt`, so the finished row keeps its start time — while the
 * same transaction bumps `conversations.lastMessageAt` to `now()`. Preferring
 * the MAX therefore sorted a long answer by the moment it BEGAN, letting every
 * conversation touched while it generated float above it. Taking the later of
 * the two puts it where the user last saw activity.
 *
 * The fallback the `COALESCE` existed for is not lost: Postgres `GREATEST`
 * IGNORES nulls and returns null only when every argument is null, so a
 * conversation whose messages were all soft-deleted or are all mid-flight still
 * reads through to `lastMessageAt`, and a conversation with messages but no
 * column still reads the MAX. It is the same expression in all three of those
 * cases and a correction only in the fourth.
 */
export const recencyExpr = sql<Date | null>`GREATEST(
  (SELECT MAX(${messages.createdAt}) FROM messages
   WHERE ${messages.conversationId} = ${conversations.id}
     AND ${messages.isActive} = true
     AND ${messages.status} != 'streaming'),
  ${conversations.lastMessageAt}
)`;

/**
 * The sort/cursor key. NOT just `recencyExpr`: a brand-new conversation can
 * have zero messages yet — recency null — and still needs a sensible position
 * (its own creation time).
 *
 * Because every branch bottoms out in `createdAt`, which is `NOT NULL`, this
 * expression is TOTAL: there is no null for `DESC`'s NULLS FIRST default to
 * float to the top of a listing. That is the property the sidebar was missing,
 * and it is a stronger guarantee than appending `NULLS LAST` to the order —
 * a null sort key would still be a row with no defined position relative to
 * its neighbours, merely at the other end.
 */
export const sortKeyExpr = sql<Date>`COALESCE(${recencyExpr}, ${conversations.createdAt})`;

/**
 * "Newest first", as the ORDER BY every conversation listing spreads.
 *
 * One declaration rather than four hand-written copies, for the reason this
 * whole module exists: the id tiebreak is not decoration, it is what makes the
 * order TOTAL, and it has to match `olderThanCursor`'s compound `(sortKey, id)`
 * comparison exactly or pagination stops agreeing with the sort. Four call
 * sites spelling that out independently is the drift this PR was written to
 * remove, reintroduced one file down.
 *
 * A FUNCTION, not a module-scope constant, and the distinction is not
 * cosmetic — `membershipNodeRelation` in `workspace-conversations-runtime.ts`
 * documents the same rule for the same reason. Calling `desc()` at import time
 * makes merely IMPORTING this module do query-builder work, so every suite that
 * mocks `@pagespace/db/operators` has to export `desc` whether or not it uses
 * the ordering. Six chat-route suites failed to collect on exactly that before
 * this was a function.
 */
export const newestFirst = () => [desc(sortKeyExpr), desc(conversations.id)] as const;

/**
 * The cursor is an OPAQUE token encoding the sort key the caller last saw —
 * NOT a bare conversationId re-resolved against LIVE data. The sort key is
 * derived from `messages`, which can change between one page fetch and the
 * next: if the cursor conversation receives a new message in that window,
 * re-deriving its key fresh would shift the boundary FORWARD, re-admitting
 * rows already shown on the previous page. Worse, if the cursor row
 * disappeared entirely (deleted), a live re-lookup finds nothing and silently
 * applies no boundary at all, returning page one again instead of the
 * requested next page (review finding).
 *
 * The sidebar's own version of this had a third failure the Agents listing
 * never could: it guarded the live lookup with `if (cursorConv?.lastMessageAt)`,
 * which is FALSY on the null that column carries for most rows, and fell
 * through to comparing `id` alone — mixing two different orderings inside one
 * scroll, so "load more" could skip rows outright. Freezing the observed sort
 * key into the cursor removes the live dependency, and the extra DB round-trip
 * it needed, entirely.
 */
export function encodeCursor(sortKey: Date | string, id: string): string {
  // The driver doesn't hydrate a raw computed SQL expression into a real
  // `Date` the way it does a schema-known timestamp COLUMN (confirmed
  // against real Postgres via drizzle's own query builder: `sortKeyExpr`'s
  // runtime value is a STRING, e.g. `"2026-07-28 12:00:00.123456"`, with full
  // microsecond precision — Postgres timestamps carry six fractional digits,
  // a plain JS `Date` only three). Round-tripping that string through
  // `new Date(...).toISOString()` truncates it to milliseconds — verified
  // against the real test DB that this silently collapses two distinct
  // sub-millisecond sort keys onto the same encoded value, making the next
  // page's boundary re-admit a row it should have excluded (review finding).
  // Preserve a string AS GIVEN; only a genuine `Date` (e.g. a plain
  // `createdAt` fallback, which is already millisecond-limited at the
  // column level) goes through `toISOString()`.
  const encoded = typeof sortKey === 'string' ? sortKey : sortKey.toISOString();
  return Buffer.from(JSON.stringify({ sortKey: encoded, id })).toString('base64url');
}

export function decodeCursor(cursor: string): { sortKey: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { sortKey?: unknown }).sortKey !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return null;
    }
    const sortKey = (parsed as { sortKey: string }).sortKey;
    // Validate it's a real, parseable timestamp — but return the ORIGINAL
    // string, not a `new Date(sortKey)` reconstruction, which would
    // re-truncate any sub-millisecond precision right back out again.
    if (Number.isNaN(new Date(sortKey).getTime())) return null;
    return { sortKey, id: (parsed as { id: string }).id };
  } catch {
    // Malformed/tampered cursor — same treatment as a cursor whose id no
    // longer resolves to anything: ignored, not an error (fails open to
    // page one, consistent with how these listings already treat an unknown
    // cursor id).
    return null;
  }
}

/**
 * The WHERE fragment for "older than this cursor", in the same total order the
 * listings sort by. Compound on `(sortKey, id)` because a sort key alone is
 * not unique — two conversations can share a timestamp, and a bare `<` would
 * drop whichever the previous page did not reach.
 */
export function olderThanCursor(decoded: { sortKey: string; id: string }) {
  return sql`(${sortKeyExpr} < ${decoded.sortKey} OR (${sortKeyExpr} = ${decoded.sortKey} AND ${conversations.id} < ${decoded.id}))`;
}
