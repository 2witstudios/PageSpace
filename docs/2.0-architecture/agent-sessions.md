# Agent Sessions — the model and the source-of-truth contract

Status: normative. This is Phase 0 of the **Agent-Session Single Source of Truth** epic.
The model in §1–§2 is shipped (PRs #2258, #2336). The contract in §3 is the epic's target
state, being landed phase by phase; each divergence is marked "today X / target Y".

The whole document compresses to one rule: **every fact has one owner, every write emits,
every subscriber can prove it is current.** If a feature needs a second copy of a fact,
it derives at read time or it doesn't ship.

## 1. The model

```
Drive (or null = global assistant)
 └─ Session / Workspace          agent_sessions row — owns ONE Sprite sandbox
     ├─ conversation w/ Agent A  conversations row, sessionId FK
     ├─ conversation w/ Agent B  (many agents, one filesystem)
     └─ shell-1, shell-2         agent_session_shells rows — PTYs in the same sandbox
```

A **session** (the `agent_sessions` table; canonically a *workspace*, see §4) is a working
context: a drive-level environment that owns one Sprite sandbox and hosts many
conversations plus any number of shells. The environment is primary; what runs inside it
lives inside it.

Shipped invariants (source: `packages/db/src/schema/agent-sessions.ts`,
`packages/db/src/schema/conversations.ts`):

- **A session is NOT a conversation.** The first cut made `conversationId` the primary
  key and folded the Sprite name from it — a cardinality error that forced one
  environment per thread. PR #2258 inverted the association: `agent_sessions.id` is its
  own cuid, and `conversations.sessionId` FKs it. The Sprite key
  (`deriveAgentSessionSpriteKey`) folds the session id, so every conversation and shell
  in a session resolves the same sandbox **by construction** — no shared id is threaded
  anywhere.
- **Binding is write-once.** `conversations.sessionId` is set at creation, or — for a
  conversation that has never had one — by exactly one guarded claim of the caller's own
  row (`conversationRepository.claimConversation`, `WHERE sessionId IS NULL AND userId =
  :caller`; `apps/web/src/lib/agent-sessions/claim-conversation-in-session.ts`). No
  UPDATE path re-points a bound row: a thread's history and its filesystem always agree.
  Moving a thread to another session is a **fork** (a new conversation), never a rebind.
- **History outlives compute.** The FK is ON DELETE SET NULL: deleting a session keeps
  its threads as plain history. Ending a session keeps its row entirely — `end` stamps
  `teardownRequestedAt` / `spriteTornDownAt` / `endedAt` and deletes nothing.
- **Ended sessions are revivable** (PR #2336). A claim or create landing in an ended
  session withdraws the end-intent (`planSessionReopen()` clears `endedAt` only; the
  confirmed-kill stamp `spriteTornDownAt` survives, so provisioning fresh-creates).
  There is no `session_ended` refusal anywhere. A reopened row is re-endable.
- **Global assistant = null `driveId`.** A global-assistant session lives outside any
  drive; access and billing fall back to `ownerId` — owner-only **by construction**
  (`packages/lib/src/agent-sessions/decide-session-access.ts`: a null-drive session has
  no drive to share through). Drive sessions authorize by drive access
  (owner/accepted member); unknown denies.
- **No `agentPageId` on the session.** A session hosts conversations with many agents,
  so the agent association lives on each conversation (`conversations.contextId`),
  never on the session.
- **Ids address, names label.** `name` carries no uniqueness constraint and nothing
  looks a session up by it. (Shell names are unique per session for tab titles only;
  lookups always go through `id`.)
- **`closedInSessionAt` ≠ `isActive`.** Closing a conversation out of its session's
  listing (`closedInSessionAt`) never touches history soft-delete (`isActive`).
  Reopening clears the stamp. Closed listings are refused by worker verbs (§2).
- **Sandbox status is derived, never stored** (`deriveSandboxStatus`,
  `packages/lib/src/services/agent-sessions/session-status.ts`): the four lifecycle
  stamps are each single-writer facts; a status column would be a second copy. This
  stays true under the epic — it is the pattern, not an exception to it.
- **Pane grid**: the server side of the relational promotion is SHIPPED (epic
  Phase 3, the #2202 machine-panes pattern): `agent_workspace_pane_columns` /
  `agent_workspace_panes` rows behind a per-workspace rev
  (`agent_workspace_layout_revs`), mutated by idempotent verbs
  (`POST /api/agent-sessions/{id}/workspace/verbs {opId, baseRev, verb}`,
  stale rev → 409 + truth) through ONE reducer (`applyVerbLocal`,
  `packages/lib/src/agent-sessions/workspace-layout-verbs.ts`) that the client
  store re-exports, each applied verb broadcasting rev-carrying
  `workspace:updated` to the `session:<id>` room. During the dual-write window
  the `workspaceState` blob is kept true by the verb engine and the legacy
  blob PUT conversely reconciles blob→rows via the same projection, under one
  per-workspace lock (drift-guard property test pins blob ≡ rows). / Still
  today: the production CLIENT still writes through the debounced blob PUT
  with a localStorage copy, and the AI tool paths (`open_page_pane`, worker
  spawn placement) still cannot write placement. / Target: the client store
  rewritten onto the verbs + live `workspace:updated` application, tool paths
  posting verbs, then the blob + localStorage copy dying at contract.
- **Pane REARRANGE (issue #2208): SHIPPED.** The verb set is complete —
  `resize_column` / `resize_pane` / `move_pane` / `reorder_columns` join the
  structural verbs in the same pure engine, and the `widthFraction` /
  `heightFraction` columns reserved by the promotion are now written, read,
  and round-tripped. This was blocked BY the promotion by design: as blob
  writes, rearrange verbs would have added yet another writer of a
  client-authored JSONB. **The fraction invariant** is stated and enforced in
  the reducer, never at a call site (`rebalanceFractions`): a container (the
  grid's columns, or one column's panes) is either wholly UNSIZED — no member
  carries a fraction, and the renderer splits it evenly — or wholly SIZED,
  with every member at or above `MIN_FRACTION` and the shares summing to 1
  within `FRACTION_EPSILON`. Never mixed, in either direction: a resize
  materializes the whole container from its even split, a membership change
  re-establishes the invariant for the new membership (newcomers take an even
  share, survivors keep their relative proportions), and wire input that
  arrives mixed is read as unsized wholesale. Every verb stays TOTAL — an
  unresolvable id, a lone-member container, and a re-sent identical resize are
  no-ops, and an out-of-range fraction or index is clamped rather than
  refused. Fractions are quantized to 1e-5 on both write and read, because the
  storage type is `real` (float4) and the store's content diff is a byte
  comparison — without a shared snap, every write would look like a change.
- **Agent-facing layout tools (issue #2208): SHIPPED.** `list_panes` /
  `resize_pane` / `move_pane` / `arrange_panes` on the session tool family —
  an agent arranging its OWN workspace, addressed by the paneId/columnId
  `list_panes` returns. They resolve the grid from the CALLER's own
  conversation (never a workspaceId the model supplies), go through
  `applyWorkspaceLayoutVerb` in-process — the same single writer, per-workspace
  lock, and op memory the verbs route uses — and derive their `opId` from the
  tool call id so an SDK retry replays instead of rearranging twice.

## 2. Authorization axioms (PR #2336 — product-locked)

These are product decisions, not implementation accidents. They supersede issue #2262
finding 1's workspace confinement.

1. **Verbs are resource-addressed and permission-gated, like `read_page`.**
   `send_session` / `read_session` / `kill_session` authorize against the resource:
   the caller owns the worker conversation, it is actually a worker (bound into some
   workspace), and its listing is not human-closed. A resource the caller does **not**
   own always reads as nonexistent — anti-enumeration, today's behavior and kept.
   For the caller's *own* rows the refusals are distinct, typed and actionable
   (shipped, epic Phase 1): an unbound thread answers `not_a_worker` with
   spawn-from-inside-it guidance, a human-closed listing answers `worker_closed`
   with the reopen-or-spawn-fresh remedy — while no-row and foreign-owner still
   collapse into one identical not-yours message. The
   calling conversation plays no authorization role and is not required. (Page-worker dispatch additionally
   re-enforces the agent's RBAC inside the standard chat pipeline it runs through.)
2. **Binding state, lifecycle state, and calling surface NEVER refuse a permitted
   operation.** Ended sessions reopen on use. Unbound threads mint a workspace
   permission-gated (global with the user's own authority; page conversations behind
   `canUserViewPage` + `checkAccessForSubject`, the manual spawn route's exact
   primitives). A thread having no session yet is a state to resolve, not an error.
3. **The global assistant is the user's own authority, from any surface** — dashboard,
   sidebar, panes, agents page. Page AI is its drive's RBAC. Neither gains or loses
   power by where the request was typed.
4. **Location's only job is defaults and pane placement.** The calling conversation
   supplies the default workspace for a spawn and decides where a pane opens — nothing
   else.
5. **Cross-workspace orchestration is legitimate.** `spawn_session` takes `workspace`
   (omitted = caller's own, minted if needed; `'new'` = fresh isolated workspace;
   an id = spawn straight into it, gated by session access). `list_sessions` lists all
   the caller's workspaces, every worker the caller owns addressable by the verbs. The
   advisory cap pre-count applies only to own-workspace spawns — a full caller
   workspace can't refuse a spawn aimed somewhere with room.
6. **Discovery is symmetric with the spawn gate.** Everything
   `spawn_session`'s explicit-`workspaceId` path would admit the caller into
   (`checkSessionAccess` → `decideAgentSessionAccess`: owner OR drive member) is
   discoverable: `list_sessions` additionally reports `sharedWorkspaces` — other
   members' sessions in drives the caller belongs to, gated per-row by that SAME
   pure decision, labeled distinctly from the caller's own. The caller's own set
   is never truncated (the spawn ceiling is structural); the member-visible set
   has no structural ceiling, so it carries its own explicit bound
   (`MAX_MEMBER_VISIBLE_WORKSPACES`, newest activity first).
7. **Foreign private-thread titles redact in listings.** A viewer listing a
   workspace they do not OWN sees a conversation's title only when the thread is
   their own or deliberately shared (`conversations.isShared`); every other row
   keeps its agent and activity time but reads `(private thread)`. The owner sees
   everything in their own workspace. One pure mechanism —
   `redactConversationTitleForViewer`
   (`packages/lib/src/agent-sessions/redact-conversation-listing.ts`) — routed
   through every viewer-facing mapping of session-conversation rows. This is a
   deliberately conservative product decision, explicitly open to veto: adjusting
   it is one function. Transcript content stays owner-gated regardless.

Unchanged by the re-model: the conversation→session binding stays write-once and
owner-only (the hijack surface stays closed); shells stay workspace-scoped
(`spawn_shell` / `send_shell` / `read_shell` / `kill_shell` act only on the caller's
own session's sandbox — a foreign shell reads as nonexistent).

## 3. The source-of-truth contract

> **Status: target state.** This section is being landed by the Agent-Session Single
> Source of Truth epic, phase by phase. Where today's code diverges, the divergence is
> named. Until a phase lands, the code is what ships; this section is where it is going.

Four clauses:

1. **Every fact has one server-side owner.** One writer per table, behind a repository
   choke point (message writes converge on a message repository; conversation
   lifecycle on the conversation repository). Routes never decide whether to
   broadcast. *Message writes: SHIPPED* (epic Phase 2 PR 2) — every durable message
   write goes through `apps/web/src/lib/repositories/message-repository.ts` (the raw
   savers are private to it), and conversation lifecycle emits from the conversation
   repositories. *Still open:* membership facts are stored three ways (FK,
   `workspaceState` jsonb, localStorage) — epic Phase 3.
2. **Every owner emits on write.** Each committed write broadcasts a rev-carrying event
   (`conversations.rev` bumped in-transaction; the event carries the post-write rev).
   *SHIPPED server-side* (epic Phase 2 PR 2): `conversation:message_created/updated/
   deleted`, `conversation:undo_applied` to the `conv:<conversationId>` room —
   unconditionally; room membership (the `join_conversation` handler +
   `canAccessConversation`) is the authorization — and directory events
   `conversation:created/updated/closed/reopened/deleted` to `user:<ownerId>:sessions`
   (plus the page room when shared). The legacy `chat:*` page-room events still emit
   in parallel (old clients depend on them; the page-room `chat:user_message` keeps
   its `isShared` gate while it lives, because the page room contains members with no
   access to private conversations); they are deleted with the client cutover
   (Phase 2 PRs 3–4).
3. **Every surface is a subscriber that can prove it is current.** Pane, sidebar, and
   agent alike hold a rev watermark; an event with `rev == watermark + 1` applies, a
   gap triggers a snapshot refetch, reconnect runs a batched rev check. Transport stays
   best-effort; correctness comes from rev + refetch, not delivery guarantees.
   *Server half shipped* (Phase 2 PR 2): every event carries the post-write rev.
   *Today, client-side:* caches apply events only for conversations already loaded and
   lists heal by 15–20s polls. *Target:* epic Phases 2–4; polls demoted to backstops.
4. **A tool action and a UI action are indistinguishable to every observer — including
   the acting agent.** A server-side `send_session` dispatch and a pane's own POST take
   the same write path, emit the same events, and appear live in the same surfaces.
   Read-your-writes holds for agents too: an agent that just wrote through a tool can
   immediately observe its own write through any read path.

The acceptance criterion, one sentence: **if a feature needs a second copy of a fact, it
derives at read time or it doesn't ship.** Forced copies get drift-guards; dual-writes
get one shared writer.

### 3a. The two message tables, mid-merge

`chat_messages` (page chat) is being merged INTO `messages` (global assistant) so the
"branch on `agentPageId === null`" that every reader carries can be deleted. It is a
textbook forced copy, so it runs under the rule above rather than around it:

- **Expand — SHIPPED** (epic Phase 4 PR 9, migrations 0248/0249): `messages` gained
  nullable `userId`, `sourceAgentId`, and a transitional `pageId`; orphan
  `conversations` rows were synthesised; `chat_messages.conversationId` gained a real
  (`NOT VALID`) FK, and so did `ai_stream_sessions.conversationId`.
- **Dual-write — SHIPPED** (Phase 4 PR 10): every page-chat write lands in BOTH tables
  inside ONE transaction. Being a choke point already is what made this a per-method
  change rather than a route-by-route migration — **no route changed**. The shared
  unified-leg writer is `apps/web/src/lib/repositories/unified-message-leg.ts`; the
  three files permitted to call it are pinned by test. Global rows are untouched:
  `messages` was always their only table, and they now carry `pageId: null`
  explicitly so a post-cutover reader can tell them apart.
  - Kill switch `UNIFIED_MESSAGES_DUAL_WRITE=off` disables the unified leg without a
    deploy (default on; only the exact value `off` disables).
  - Historical rows are carried across by `scripts/backfill-unify-messages.ts` —
    batched, resumable from the target table, idempotent, `--dry-run`.
  - **Drift guards, both layers:** a vitest suite asserting every write path touches
    both legs (and that nothing outside the allowlist writes `chat_messages` at all),
    plus the `reconcile-message-unification` cron comparing per-conversation counts and
    `MAX(createdAt)` for recently-active page conversations, logging at error level on
    divergence.
- **Reader cutover, internal readers — SHIPPED** (Phase 4 PR 11): the session tools'
  transcript readers, the agent-session conversation listing, the search / page-read /
  agent-communication tools, memory discovery, both pulse routes, the page-payload
  service, the admin users route and `GET /api/v1/conversations/[id]` all read
  `messages` now. Two rules govern the rewrite:
  - **Page scope comes from the JOIN, not the column.** `chat_messages.pageId = X`
    became `JOIN conversations ON id = "conversationId" WHERE type = 'page' AND
    "contextId" = X`. `conversations.contextId` is the end-state authority and is
    indexed; `messages.pageId` is transitional and is dropped at PR 15, so nothing new
    is built on it. One consequence is deliberate: a `type='client'` conversation's rows
    NAME a page but do not BELONG to that page's chat, so they no longer appear in
    page-scoped reads — they are still reached, as before, by `conversationId`.
  - **A conversation id already implies its page.** Readers keyed on
    `(pageId, conversationId)` keep only the conversation key unless the page predicate
    was an authorization check, in which case it survives as the join.
  - Parity is pinned by
    `apps/web/src/lib/repositories/__tests__/unified-reader-parity.integration.test.ts`
    (old query vs new query over one deliberately awkward corpus), which lives until
    PR 15 deletes `chat_messages`.
- **Reader cutover, chat routes + mutation surfaces — SHIPPED** (Phase 4 PR 12): both
  chat routes' history loads, the page-agents conversation/message routes, the consult
  route, the ask_user resume/dismiss reads, the edit/delete reads, undo, the rollback and
  redo message executors, the page payload, the retention purge and
  `POST /api/v1/chat/completions` all read `messages` now. Two repositories died with
  it: `chat-message-repository.ts` was absorbed WHOLESALE into `message-repository.ts`
  (which is now the one writer AND the one reader for durable messages), and
  `global-conversation-repository.ts` gave up its message-table half and kept only
  `conversations` rows.
  - **The page scope here is WIDER than PR 11's, deliberately.** These are the paths a
    user drives, so they keep exact behavioural parity with `chat_messages.pageId = X`:
    `unifiedPageScope()` (`apps/web/src/lib/repositories/unified-message-scope.ts`) is
    the conversation join OR the transitional `messages.pageId`. The second disjunct is
    what keeps a `type='client'` thread — an API-managed conversation whose `contextId`
    is a DRIVE — reachable from `POST /api/v1/chat/completions`'s history load and from
    its own edit/delete route. PR 11's internal readers chose the narrower "page
    conversations only" form; the difference is asserted, not assumed, by the parity
    suite, and the contract PR that drops `messages.pageId` has to give `type='client'`
    threads a real page link.
  - **A page route must still 404 a global message.** `messages` now holds every kind of
    row, so `getMessageById` resolves ids that had no `chat_messages` row before. It
    returns a DERIVED `pageId`, and `null` there is what the page edit/delete routes
    reject on — the global assistant keeps its own route and its own ownership check.
  - **Permanent page delete had to grow a statement.** `chat_messages.pageId` carries an
    ON DELETE CASCADE to `pages`; `messages.pageId` deliberately does not, and
    `conversations.contextId` never had a foreign key. Without the explicit DELETE the
    trash route now issues, a permanently deleted page's chat history would outlive it.
  - The matrix is exercised, not asserted: page chat, global chat and worker dispatch by
    `apps/e2e/tests/15-chat-fixture-smoke.spec.ts` and `16-dispatch-multiplayer.spec.ts`;
    edit, delete, undo, interrupt/resume, purge and page teardown by
    `apps/web/src/lib/repositories/__tests__/chat-mutation-matrix.integration.test.ts`
    against a real Postgres.
- **Compliance legs — SHIPPED** (Phase 4 PR 13). The three compliance paths are
  deliberately ASYMMETRIC while both tables exist:
  - **GDPR export reads the UNIFIED table only.** Since the dual-write + backfill,
    `messages` is a superset of `chat_messages` under the SAME primary keys, so
    reading both exported every page-chat row twice. It also stopped keying on
    `messages.userId` alone: that column is the HUMAN author and is NULL for every
    agent-authored row, so the old query exported the subject's questions and dropped
    every answer inside their own page chats — while the same answer in a GLOBAL
    thread WAS exported, because the global writer stamps the owner's id on assistant
    rows. The predicate is now "rows the subject authored, plus unattributed rows in a
    conversation the subject OWNS", which never picks up another human's messages from
    a shared thread (Art 15(4)).
  - **Erasure and retention keep BOTH legs** until PR 15 drops `chat_messages`: while
    rows physically exist there, an Art 17 request and the retention window must still
    reach them. Pinned by
    `packages/lib/src/compliance/__tests__/message-unification-compliance-legs.test.ts`.
  - **The 0248/0249 cascades made both paths delete MORE, deliberately.** A
    `conversations` delete now takes its `chat_messages` rows (0248) and its
    `ai_stream_sessions` rows (0249) with it. The latter closed a real leak — `parts`
    checkpoints are message content and nothing in the codebase had ever deleted one.
    Retention's conversation sweep is consequently sequenced AFTER the two message-leg
    sweeps, because a cascading DELETE running concurrently with a direct DELETE over
    the same rows can deadlock.
  - **A residual hole the cascade cannot close** got its own erasure step,
    `purge-stream-state`: a shared conversation accepts streams from any member, so
    `ai_stream_sessions`/`ai_pending_abort_intents` rows carrying the MEMBER's user_id
    inside the OWNER's conversation survive the member's erasure. The step is
    user-scoped and fatal.
- **Still open:** `chat_messages` and `messages.pageId` are dropped last (Phase 4 PR 15),
  which is also when the compliance legs collapse to one and `type='client'` threads need
  a real page link (see the wider page scope above).

Reads come from `messages` while the dual-write still populates BOTH legs: every save,
the History-delete cascade, undo, the rollback/redo executors and page teardown all still
write `chat_messages`, and the retention cron still sweeps it. That is what makes a revert
of the reader cutover safe on its own — the legacy leg it would fall back to never stopped
being correct. It is also why the unified INSERT paths skip (loudly, at error level)
rather than abort when a `conversations` row is genuinely missing: the unified leg must
never be able to break a write that works today.

## 4. Vocabulary

"sessionId" has carried five meanings. The canonical names:

| Canonical name | What it is | Where "sessionId" meant this |
|---|---|---|
| `workspaceId` | An `agent_sessions` row — the working context / sandbox owner | Everywhere except the tool layer: `conversations.sessionId`, `agent_session_shells.sessionId`, `/api/agent-sessions/[sessionId]`, `?session=` URLs |
| `conversationId` | A thread (`conversations` row) | The session-tool layer: the `sessionId` param of `send_session` / `read_session` / `kill_session` is a **worker's conversation id** (`apps/web/src/lib/ai/tools/session-tools.ts` — mapped to a `conversationId` local at the zod boundary; internally `WorkerRow.conversationId`, with `WorkerRow.workspaceId` naming the workspace) |
| *(frozen)* `sessionId` | The model-facing tool param | The wire vocabulary is deliberately frozen at the zod boundary: to the model, a "session" is a worker you talk to and a "workspace" is the environment. Internal renames never touch these schemas |
| `paneId` / `columnId` | One rectangle of a workspace's grid, and the vertical stack it sits in | The layout tools (`list_panes` / `resize_pane` / `move_pane` / `arrange_panes`, issue #2208). These sit on the WORKSPACE side of the frozen split — panes are furniture of the environment — so they deliberately say "pane"/"column"/"workspace" and never "session". They take no workspaceId at all: the grid is the caller's own, resolved from its conversation |
| `spriteExecId` | The Sprite PTY exec stream a shell reattaches under | `agent_session_shells.streamSessionId` (rename lands in the epic's final phase) |
| — | Auth login sessions (`sessions` table, `packages/db/src/schema/sessions.ts`) | Unrelated. Never mix with any of the above |

Also nearby but distinct: `ai_stream_sessions` (a background streaming *run* of one chat
turn) is a run record, not an address in any of the five senses.

The epic's final phase renames the DB/module/route layer to match (`agent_sessions` →
`agent_workspaces`, `conversations.sessionId` → `workspaceId`, etc., with one-release
compat shims). Until then, this table is the decoder.

## 5. Keeping this honest

Tool guidance has lied to the model before — this is a recurring bug class, not a
hypothetical. The `session-tools.ts` module header documented a cross-workspace
confinement guard for a full release after PR #2336 deleted it. A description the code
no longer enforces is worse than no description: the model plans around it.

The normative sources for session semantics are, in order:

1. **The contract tests** (shipped, epic Phase 1):
   `apps/web/src/lib/ai/tools/__tests__/session-tools-schema.test.ts` pins the
   model-facing wire surface — every tool's name, description, and JSON input
   schema, as explicit literals — and
   `apps/web/src/lib/ai/tools/__tests__/session-tools-contract.test.ts` pins each
   tool description's behavioral claims to the gates that enforce them (with the
   runtime-wired claims, e.g. kill_session's never-tears-the-sandbox-down, in
   `session-tools-runtime.test.ts`). A description that drifts from behavior
   fails CI instead of shipping.
2. **This document** for the model and the axioms.
3. Schema doc comments (`agent-sessions.ts`, `conversations.ts`) for per-column
   rationale.

A PR that changes session semantics — a verb's gates, the binding rules, lifecycle
stamps, event emission — must update the contract tests **and** this document in the
same PR. If this document and the code disagree and no test catches it, fixing the
disagreement is the first commit of whatever you were doing.
