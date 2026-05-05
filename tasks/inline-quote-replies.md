# Inline Quote Replies Epic

**Status**: 📋 PLANNED
**Goal**: Add Slack/Twitter-style inline quote replies to channels and DMs without disturbing the just-shipped thread system.

## Overview

We just shipped 1-level threads (PRs #1244, #1247, #1248), but threads pull conversation off the main feed into a side panel. Some replies belong inline — short reactions, "this," follow-ups the rest of the room should see in context. Quote replies are orthogonal to threads: they're top-level messages that visibly embed the original they're replying to. The schema already encodes "this row references another" twice (`parentId`, `mirroredFromId`); `quotedMessageId` is the third instance of the same shape and slots in additively. Single PR, executed as 9 sequenced TDD-gated subtasks. Eric-Elliott principles honored throughout: pure data flow (column → batched enrichment fn → API field → renderer prop), composition over coupling (one helper serves channels and DMs identically), single source of truth (FK is canonical, snapshot is read-time), minimal surface (zero new endpoints, zero new realtime events, zero new tables, zero new stores).

---

## Schema column

Add nullable `quotedMessageId` self-FK to `channelMessages` and `directMessages` (mirroring the existing `parentId` and `mirroredFromId` shapes), plus a btree index for the enrichment lookup. Generate the migration via `pnpm db:generate`.

**Requirements**:
- Given a hard-deleted original message, should preserve the quoting reply via `onDelete: 'set null'` so quote-replies never cascade-delete.
- Given a soft-deleted original (`isActive: false`), should keep the FK intact so the renderer can show a tombstone instead of vanishing the embed.
- Given a generated migration, should contain only two `ADD COLUMN` and two `CREATE INDEX` statements — no other drift.

---

## Preview utility relocation

Move `apps/web/src/lib/channels/build-thread-preview.ts` to `packages/lib/src/services/preview.ts` and update existing callers (channel POST route, agent mention responder).

**Requirements**:
- Given the enrichment helper will live in `packages/lib`, should not import from `apps/web` (forbidden direction).
- Given existing callers depend on the 100-char ellipsis behavior, should preserve the function signature exactly so this is a pure relocation, not a refactor.

---

## Quote enrichment helper (TDD)

Write `packages/lib/src/services/quote-enrichment.ts` exporting `attachQuotedMessages(rows, scope)` — a pure function that batches a single `SELECT ... WHERE id IN (...)` against the relevant message table joined to `users`, and returns rows shape-merged with `quotedMessage: QuotedMessageSnapshot | null`. Tests first.

**Requirements**:
- Given a batch of rows where most have no quote, should issue zero database queries (early-return).
- Given a batch with multiple distinct `quotedMessageId` values, should issue exactly one query (no N+1).
- Given multiple rows pointing at the same quoted id, should de-duplicate the IN-list to one occurrence.
- Given a quote pointing at a soft-deleted message, should return `quotedMessage` populated with `isActive: false` (the IN-query must NOT filter by `isActive`).
- Given a quote pointing at a non-existent id (e.g., hard-deleted), should return `quotedMessage: null`.

---

## Repository writes accept quotedMessageId

Extend `InsertChannelMessageInput` and `insertChannelMessage` (`channel-message-repository.ts:120-142`) and the DM equivalent to thread `quotedMessageId` through to the Drizzle insert. Extend the column-name string maps in both repository test files. Do not modify `messageWith` (line 25-50). Do not touch `insertChannelThreadReply` / `insertDmThreadReply`.

**Requirements**:
- Given the insert helper receives `quotedMessageId`, should persist it on the row without otherwise altering the existing insert payload shape.
- Given the test column-name maps mock Drizzle inserts, should include `quotedMessageId` so missing columns can no longer make assertions silently pass with `undefined`.
- Given thread reply repository helpers, should remain untouched (quote replies and thread replies are orthogonal concepts).

---

## API surface — channel

In `apps/web/src/app/api/channels/[pageId]/messages/route.ts`: validate optional `quotedMessageId` on POST (lines 240-246) by reusing `findChannelMessageInPage`; reject if missing, soft-deleted, or `parentId !== null`. After `loadChannelMessageWithRelations` (line ~512), run `attachQuotedMessages([row], 'channel')` before the realtime broadcast (lines 521-538) and the response. Run enrichment on the GET list (lines 199-217).

**Requirements**:
- Given a `quotedMessageId` referring to a thread-only message (`parentId !== null`), should reject with the same `parent_not_top_level` predicate phrasing used at `channel-message-repository.ts:367-369`.
- Given a `quotedMessageId` referring to a message in a different channel, should reject — `findChannelMessageInPage` enforces same-pageId, no second permission check needed.
- Given a successful POST, should broadcast `new_message` with the denormalized `quotedMessage` riding along — no new realtime event types.
- Given the AI mention responder scans `messageContent` only, should NOT fire when a quoted message contains an `@`-mention syntax string in its snapshot snippet (one-line code comment to deter future "fixes").

---

## API surface — DM

Symmetric changes to `apps/web/src/app/api/messages/[conversationId]/route.ts` — POST validation + enrichment on GET/POST. Same-conversationId constraint is the only ACL gate.

**Requirements**:
- Given a `quotedMessageId` referring to a message in a different DM conversation, should reject with the conversation-scope analog of `parent_not_top_level`.
- Given a successful DM POST, should ride the existing `new_message` payload with `quotedMessage` populated.

---

## MessageQuoteBlock component

New file `apps/web/src/components/messages/MessageQuoteBlock.tsx`. Props: `{ quoted: QuotedMessageSnapshot | null; onJumpToOriginal?: (id: string) => void }`. Render an avatar + name + relative time + 1-line truncated snippet rendered through `MessagePartRenderer` so inline mentions in the snippet still get parsed. Tests for tombstone and active branches. Do not modify `MessagePartRenderer.tsx`.

**Requirements**:
- Given `quoted === null` or `quoted.isActive === false`, should render a muted tombstone "Original message deleted" rather than nothing.
- Given an active quote whose snippet contains an `@[label](id:type)` mention, should render the mention through the existing renderer rather than as raw syntax.
- Given `MessagePartRenderer.tsx`, should not be modified — the quote is a sibling to `attachmentMeta`, not a new part variant.

---

## Composer chip in ChannelInput

Extend `ChannelInput.tsx` props (lines 21-50) with `quotedMessageId?`, `quotedPreview?: { authorName, snippet } | null`, `onClearQuote?`. Render a dismissible chip inside `InputCard` (next to the existing attachment preview at lines 271-315) when `quotedPreview` is set. Reuse the attachment-chip visual language. Composer remains controlled — parent owns state.

**Requirements**:
- Given the existing convention that `parentId` is a prop (not internal state), should treat `quotedMessageId` the same way — controlled by the parent view.
- Given an attachment chip exists at lines 271-315, should match its visual language and dismiss-X interaction for consistency.

---

## View wiring (channel + DM)

In `ChannelView.tsx`: add "Quote reply" `DropdownMenuItem` to both hover dropdowns (lines 468-494 and 547-573), visible to everyone (not author-gated). Lift `quotedMessageId` + `quotedPreview` to local state, compute preview from the in-memory message list (no extra fetch), include `quotedMessageId` in the body assembled by `handleSendMessage`, clear on success. Render `MessageQuoteBlock` before message parts when `m.quotedMessage` is present. Symmetric in DMView. Bonus: `useThreadPanelStore` exists but is unwired — add "Reply in thread" alongside "Quote reply" to close that loop.

**Requirements**:
- Given any user (not just author) hovers a message, should see "Quote reply" in the dropdown — Edit/Delete remain author-gated; Quote does not.
- Given the original is already in the rendered message list, should compute the chip preview from memory without an additional fetch.
- Given `useThreadPanelStore` is implemented but unwired, should add "Reply in thread" in this same task to close the dangling integration.
- Given the user clicks "Quote reply", should focus the composer textarea so they can immediately type.

---

## Pitfalls (carry-forward, not subtasks)

1. Enrichment IN-query must NOT filter `isActive = true` — tombstone is the renderer's job.
2. `apps/web` may import `packages/lib`, never the reverse — preview move must precede enrichment helper.
3. Mocked Drizzle column maps in repo tests must include `quotedMessageId` or assertions silently pass with `undefined`.
4. AI mention responder uses `messageContent` only — quoting an @-agent must NOT re-trigger; add a one-line comment.
5. No second permission check — same-channel/same-conversation already gates read access.
6. Resist adding a Drizzle self-relation in `messageWith`; eager-loading soft-deleted parents into every read path is the trap.

## Verification (epic-level, post all subtasks)

- `pnpm db:generate` produces only the additive migration.
- `pnpm test:unit`, `pnpm typecheck`, `pnpm lint` green.
- E2E in `pnpm dev`: hover → Quote reply → chip → send → embed renders; edit original → embed reflects on reload; soft-delete original → tombstone; cross-tab realtime delivers embed; thread-only and cross-channel quotes get rejected at API.

## Out of scope

Quote-of-a-quote nesting depth limits (depth 1 by display); historical backfill (column nullable, no data); cross-channel quotes (rejected); quote-reply inside thread panel (threads stay orthogonal).
