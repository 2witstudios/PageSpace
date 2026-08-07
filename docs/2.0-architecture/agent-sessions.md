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
 └─ Session / Workspace          agent_workspaces row — owns ONE Sprite sandbox
     ├─ conversation w/ Agent A  conversations row, sessionId FK
     ├─ conversation w/ Agent B  (many agents, one filesystem)
     └─ shell-1, shell-2         agent_workspace_shells rows — PTYs in the same sandbox
```

A **session** (the `agent_workspaces` table; canonically a *workspace*, see §4) is a working
context: a drive-level environment that owns one Sprite sandbox and hosts many
conversations plus any number of shells. The environment is primary; what runs inside it
lives inside it.

Shipped invariants (source: `packages/db/src/schema/agent-workspaces.ts`,
`packages/db/src/schema/conversations.ts`):

- **A session is NOT a conversation.** The first cut made `conversationId` the primary
  key and folded the Sprite name from it — a cardinality error that forced one
  environment per thread. PR #2258 inverted the association: `agent_workspaces.id` is its
  own cuid, and `conversations.sessionId` FKs it. The Sprite key
  (`deriveAgentSessionSpriteKey`) folds the session id, so every conversation and shell
  in a session resolves the same sandbox **by construction** — no shared id is threaded
  anywhere.
- **Binding is write-once.** `conversations.sessionId` is set at creation, or — for a
  conversation that has never had one — by exactly one guarded claim of the caller's own
  row (`conversationRepository.claimConversation`, `WHERE sessionId IS NULL AND userId =
  :caller`; `apps/web/src/lib/agent-workspaces/claim-conversation-in-session.ts`). No
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
  (`packages/lib/src/agent-workspaces/decide-workspace-access.ts`: a null-drive session has
  no drive to share through). Drive sessions authorize by drive access
  (owner/accepted member); unknown denies.
- **No `agentPageId` on the session.** A session hosts conversations with many agents,
  so the agent association lives on each conversation (`conversations.contextId`),
  never on the session.
- **Ids address, names label.** `name` carries no uniqueness constraint and nothing
  looks a session up by it. (Shell names are unique per session for tab titles only;
  lookups always go through `id`.)
- **`closedInWorkspaceAt` ≠ `isActive`.** Closing a conversation out of its session's
  listing (`closedInWorkspaceAt`) never touches history soft-delete (`isActive`).
  Reopening clears the stamp. Closed listings are refused by worker verbs (§2).
- **Sandbox status is derived, never stored** (`deriveSandboxStatus`,
  `packages/lib/src/services/agent-workspaces/workspace-status.ts`): the four lifecycle
  stamps are each single-writer facts; a status column would be a second copy. This
  stays true under the epic — it is the pattern, not an exception to it.
- **Pane grid: COMPLETE** (epic Phase 3, the #2202 machine-panes pattern).
  `agent_workspace_pane_columns` / `agent_workspace_panes` rows behind a
  per-workspace rev (`agent_workspace_layout_revs`) are the ONE source of
  truth, mutated only by idempotent verbs
  (`POST /api/agent-workspaces/{id}/workspace/verbs {opId, baseRev, verb}`,
  stale rev → 409 + truth) through ONE reducer (`applyVerbLocal`,
  `packages/lib/src/agent-workspaces/workspace-layout-verbs.ts`) that the client
  store re-exports, each applied verb broadcasting rev-carrying
  `workspace:updated` to the `session:<id>` room. The three-way membership
  duplication is gone: the `agent_workspaces.workspaceState` jsonb blob was
  dropped at the contract step (migration 0252, guarded by a pre-drop
  RAISE-EXCEPTION check that no blob described a pane binding the rows
  lacked), the localStorage grid copy and its hydration latches died with the
  client rewrite, and the debounced blob `PUT` is retired — it answers 410 and
  the route is `GET`-only. What rows deliberately do NOT own is derived on
  read: pane LABELS join the conversation/shell/page title at read time (so a
  rename can never leave a stale label), and FOCUS is client-local — the
  server anchors placement on the first pane and never restores focus
  cross-device (#2048). The `GET`'s legacy whole-state `workspace` field
  survives as a projection of the same rows, for pre-verbs clients only.
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
   (`packages/lib/src/agent-workspaces/redact-conversation-listing.ts`) — routed
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
   repositories. *Pane membership: SHIPPED* (epic Phase 3) — the three-way
   store (FK, `workspaceState` jsonb, localStorage) collapsed to the FK plus
   the relational pane rows; the jsonb column and the localStorage copy are
   both gone.
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

### 3a. One message table — COMPLETE

`chat_messages` (page chat) was merged INTO `messages` (global assistant) and DROPPED at
migration **0253**. The "branch on `agentPageId === null`" every reader used to carry is
gone, and so is the table. This section is now history plus one live rule; the arc is
closed.

**The live rule.** A message row does not name its page. Its CONVERSATION does, and each
conversation kind names it in its own column:

| `conversations.type` | Where its page lives | What it is |
|---|---|---|
| `page` | `contextId` | The in-app page chat |
| `client` | `agentPageId` | An API-managed thread (`POST /api/v1/conversations`); its `contextId` is a DRIVE, and that is load-bearing — it is what a drive-scoped MCP token is authorized against |
| `global`, `drive` | — | No page |

That derivation is written down in exactly one place —
`unifiedPageScope()` / `derivedPageId()` in
`apps/web/src/lib/repositories/unified-message-scope.ts` — and every page-scoped reader
calls it. Getting the translation subtly different at each of the ~8 call sites is the
failure mode that module exists to prevent.

`conversations.agentPageId` is WRITE-ONCE and stamped lazily: the page is not known when
`POST /api/v1/conversations` mints the row (the model, and therefore the agent page,
arrives with the first completion), so the thread's first
`POST /api/v1/chat/completions` claims it via
`conversationRepository.stampClientConversationPage` (`WHERE type='client' AND
"agentPageId" IS NULL`) — the same shape, and the same reasoning, as `claimConversation`.
A later request naming a different agent never re-points a thread whose history and
edit/delete permissions are already anchored to the first page.

**How it got here**, briefly, because the sequencing is the reusable part:

- **Expand** (PR 9, migrations 0249/0250): `messages` gained nullable `userId`,
  `sourceAgentId` and a transitional `pageId`; orphan `conversations` rows were
  synthesised; `chat_messages.conversationId` and `ai_stream_sessions.conversationId`
  gained real (`NOT VALID`) FKs.
- **Dual-write** (PR 10): every page-chat write landed in BOTH tables inside ONE
  transaction, through one shared writer. Historical rows were carried by
  `scripts/backfill-unify-messages.ts` (batched, resumable, idempotent).
- **Reader cutover** (PRs 11–12): internal readers first, then both chat routes and every
  mutation surface. `chat-message-repository.ts` was absorbed WHOLESALE into
  `message-repository.ts`, which is now the one writer AND the one reader for durable
  messages; `global-conversation-repository.ts` kept only its `conversations` half.
- **Compliance** (PR 13): export cut over to the unified table alone (it was already a
  superset, so reading both duplicated every page-chat row); erasure and retention kept
  BOTH legs, because rows that physically exist are rows a subject can demand the erasure
  of. That asymmetry ended with the table.
- **Freeze** (PR 14, migration 0251): `messages` became the sole write target, and
  `ALTER TABLE chat_messages VALIDATE CONSTRAINT` produced the receipt — a legacy row
  whose conversation does not exist is a row `messages` would have REFUSED, so a passing
  VALIDATE proves the copy is completable.
- **Contract** (PR 15, migration 0253 — the only irreversible step in the epic): a final
  idempotent sweep, a completeness guard, `DROP TABLE chat_messages`, and
  `messages."pageId"` dropped behind the `type='client'` page link above.

Four things about the contract step are worth keeping, because they are the parts that
were not obvious:

- **The migration is the backfill.** Tenant/onprem deployments can skip versions and have
  no operator to run a script, so 0253 re-runs the copy itself before dropping anything.
  On cloud it is a no-op; that is the point of writing it anyway.
- **The completeness guard compares ROWS, not CONTENT.** Since PR 14 froze the legacy
  leg, every edit, soft-delete, undo tombstone and interrupted-stream materialisation
  landed on `messages` alone — so divergent content is the NORMAL state of a healthy
  database, and a content-equality guard would have refused to deploy on any database
  that had ever served an edit. What must not be lost is a row. The guard `RAISE`s with
  counts and up to 50 ids, and the table survives the refusal.
- **What the drop cost, once.** A `type='client'` thread whose requests named two
  different agent pages had its history load silently truncated to the subset matching
  the request's page. Moving the page to the conversation fixed that; those threads now
  load whole, anchored to the first agent they spoke to (the migration counts and reports
  them).
- **Permanent page delete stays explicit.** `conversations.contextId` has never been a
  foreign key and `conversations.agentPageId`'s is `ON DELETE SET NULL`, so the trash
  route issues the DELETE itself — collecting both kinds of conversation before the
  `pages` row goes. The `chat_messages.pageId` cascade that used to cover this went with
  the table.

Retired with the merge, in the same PR: the reader-parity suites, the structural freeze
guard, the `reconcile-message-unification` cron and its route/module, the compliance
legs' legacy half (`purge-stream-state` and every unified path stay), the debug
`GET /api/debug/chat-messages`, the backfill script, and the tenant-export registry
entry. A coexistence window's scaffolding is only honest while the window is open.

### 3b. One chat pipeline behind two URLs

Two message tables forced two chat routes: `POST /api/ai/chat` for page agents and
`POST /api/ai/global/[id]/messages` for the global assistant. The table merged (3a), so
the second implementation went too.

**Both URLs still exist and their wire contracts are untouched** — auth, body, statuses,
headers, stream. Deployed browsers, desktop, mobile, MCP clients, the CLI and any running
agent address them by name, and retiring a URL is a separate decision with its own compat
window. What changed is that both now call ONE entry,
`apps/web/src/lib/ai/chat-pipeline/handle-chat-turn.ts`, which does the header check, the
auth (with the surface's own options), the size guard and the parse once — and then picks
the page-agent or global-assistant strategy **from the conversation, not from the URL**.

The consequence worth naming: `dispatchThroughChatPipeline` no longer branches on
`agentPageId === null` to choose a URL. Server-side dispatch names one internal path for
every worker; a page worker carries `chatId`, a global worker carries none and the entry
resolves its conversation. That branch was the last visible trace of the two-table era in
the send path.

`/api/ai/chat` therefore accepts one shape it used to refuse: a request with no `chatId`
whose `conversationId` resolves to an existing global-assistant conversation. That is the
whole widening, it is fail-closed (the global strategy independently re-checks owner +
`type='global'` + `isActive`), and an MCP token still cannot reach the global assistant
through it — MCP has never been able to drive the global assistant and the entry refuses
with the same answer the session-only route always gave.

**Two strategies, not one merged function, and deliberately so.** Beyond the shared
prologue the two turns genuinely differ — the authorization subject (agent page vs
conversation), MCP drive scoping, conversation minting rules, the tool set (per-agent
allowlist and sandbox gating vs always-search-mode), system-prompt construction, the
credit path (page chat aborts mid-stream on exhaustion), provider admission order, the
history seam, @mention notification, the realtime gates, and usage telemetry. Collapsing
those into one function would mean twenty conditionals in the app's highest-risk path,
several of them security decisions. The table of divergences is maintained in the entry's
own docblock; the one stretch that WAS duplicated rather than merely similar — takeover,
stream lifecycle and the `'streaming'` placeholder under a per-conversation advisory lock
— is shared outright in `start-chat-generation.ts`, because a lock protocol maintained
twice is a lock protocol that drifts into double generation and double billing.

### 3c. The choke point has a guard again

Clause 1 is a property of the whole tree, not of one module: it holds only while NO
other file writes `messages`. The coexistence window had a structural writer-classification
test enforcing exactly that (`unified-message-dual-write-drift.test.ts`, later the freeze
guard), and it was retired with the window at the contract PR. Three bypasses shipped in
the gap — the undo service, and the two deletion paths below — and a
requirements-traceability audit, not CI, is what found them.

The guard is reinstated as
`apps/web/src/lib/repositories/__tests__/messages-write-site-classification.test.ts`:
it scans the shipped source for every `messages` INSERT / UPDATE / DELETE and fails
unless the file is the repository choke point or a **classified exemption carrying a
written reason**. Two exemptions stand, and the reasoning is the point:

- **`conversation-cleanup.ts` (permanent page/drive delete) — EXEMPT.** It destroys the
  `conversations` row in the same transaction as its messages. There is no surviving
  row to bump a rev on and no room to emit into that outlives the statement; the
  conversation *is* the thing being deleted. Panes heal on the page/drive deletion
  events this path already fans out, which say strictly more than a rev bump would.
- **`retention-engine.ts` (nightly retention sweep) — EXEMPT.** It hard-deletes rows
  that are ALREADY `isActive: false` and past the cutoff. Every one of them was hidden
  from every reader — and had its rev bumped and its event emitted — at soft-delete
  time, by the choke point. The hard delete changes nothing any client can observe, so
  a per-row bump would emit pure noise. Exempt because the user-visible transition
  already emitted, not because bulk deletion is beneath the contract.
- **Undo — NOT EXEMPT, and now fixed.** It soft-deletes a range of messages in response
  to a user's own click, in a pane that user is by definition watching: not bulk, not
  administrative, not invisible. Its write goes through
  `messageRepository.softDeleteUndoRange`, which bumps the rev on the caller's
  transaction; the route only emits.

That last one is worth stating as a general rule, because it is the trap the original
code fell into. **The bump is the fallback FOR the emit, not a companion to it.** An emit
that fails is survivable: the rev moved, the client notices the mismatch on its next
sync (clause 3) and refetches. A BUMP that fails is not: server and client agree on a rev
that no longer describes the data, so there is nothing for the client to notice, and the
pane is stale until a manual reload. A rev bump therefore belongs in the write's
transaction and nowhere else — never in a post-commit block, never in a second
transaction, and never under a `catch` that swallows.

### 3d. Deploy order: realtime BEFORE web

`apps/realtime` owns the room grammar and the socket handlers (`join_conversation`,
`join_session`) that `apps/web`'s client code emits into, so the dependency is one-way:
**new web needs new realtime**. `.github/workflows/docker-images.yml` deploys them in
that order, and `apps/realtime/src/__tests__/deploy-order.guard.test.ts` pins it.

It shipped the other way round for the whole epic while several PR bodies and a source
comment (`apps/realtime/src/terminal/shell-activity.ts`) asserted this ordering as
already-true. The failure mode of getting it backwards is why the claim mattered and why
nobody noticed it was false: Socket.IO **silently drops** an event with no registered
listener — no error, no ack, no disconnect. A new web client emitting `join_conversation`
at an old realtime therefore believes it joined, never enters the room, and receives none
of the rev-carrying `conversation:*` events fanned out to it. Live delivery degrades to
nothing for the length of the deploy, invisibly, with no signal the client could retry
on.

Realtime-first inverts that into the benign case: an old web client simply never emits
the new joins, and the new handlers idle until it reloads. Nothing depends on web-first —
realtime makes no outbound HTTP calls to web at all (`WEB_APP_URL` is a CORS origin),
and both services deploy after the migration step they share.

## 4. Vocabulary

"sessionId" carried five meanings. **The epic's final phase (Phase 5) landed the renames,
so the schema, the modules and the routes now say what they mean** — the table below is no
longer a decoder for a divergent codebase, it is the vocabulary itself, plus the one
deliberate exception (the frozen tool wire) and the shims that expire next release.

| Canonical name | What it is | Where "sessionId" used to mean this |
|---|---|---|
| `workspaceId` | An `agent_workspaces` row — the working context / sandbox owner | Everywhere except the tool layer. Renamed in Phase 5: `conversations.sessionId` → `workspaceId`, `agent_session_shells.sessionId` → `agent_workspace_shells.workspaceId`, `/api/agent-sessions/[sessionId]` → `/api/agent-workspaces/[workspaceId]`, `?session=` → `?workspace=` |
| `conversationId` | A thread (`conversations` row) | The session-tool layer: the `sessionId` param of `send_session` / `read_session` / `kill_session` is a **worker's conversation id** (`apps/web/src/lib/ai/tools/session-tools.ts` — mapped to a `conversationId` local at the zod boundary; internally `WorkerRow.conversationId`, with `WorkerRow.workspaceId` naming the workspace) |
| *(frozen)* `sessionId` | The model-facing tool param | The wire vocabulary is deliberately frozen at the zod boundary: to the model, a "session" is a worker you talk to and a "workspace" is the environment. Internal renames never touch these schemas |
| `paneId` / `columnId` | One rectangle of a workspace's grid, and the vertical stack it sits in | The layout tools (`list_panes` / `resize_pane` / `move_pane` / `arrange_panes`, issue #2208). These sit on the WORKSPACE side of the frozen split — panes are furniture of the environment — so they deliberately say "pane"/"column"/"workspace" and never "session". They take no workspaceId at all: the grid is the caller's own, resolved from its conversation |
| `spriteExecId` | The Sprite PTY exec stream a shell reattaches under | `agent_session_shells.streamSessionId` and `TerminalSession.sessionId` (realtime). Both renamed in Phase 5 |
| `spriteKey` | The opaque HMAC name a workspace's Sprite is provisioned under | `agent_sessions.sessionKey`, renamed in Phase 5. Distinct from realtime's `sessionKey`, which is the PTY map key (`shell:<shellId>`) and keeps its name |
| — | Auth login sessions (`sessions` table, `packages/db/src/schema/sessions.ts`) | Unrelated. Never mix with any of the above |

Also nearby but distinct: `ai_stream_sessions` (a background streaming *run* of one chat
turn) is a run record, not an address in any of the five senses. So is
`monitoring.session_id` (`AIUsageData.sessionId`), a shared analytics column many
unrelated sources write; the sandbox billing/storage paths map a `workspaceId` onto it at
the boundary rather than renaming a column they do not own.

### What Phase 5 renamed, and what it deliberately did not

Renamed: tables `agent_sessions` → `agent_workspaces` and `agent_session_shells` →
`agent_workspace_shells`; columns as in the table above; module directories
(`packages/lib/src/agent-sessions/`, `packages/lib/src/services/agent-sessions/`,
`apps/web/src/lib/agent-sessions/` → `agent-workspaces/`) and the schema file; routes
`/api/agent-sessions/**` → `/api/agent-workspaces/**`.

**FROZEN, and not renamed:** the model-facing tool vocabulary. `spawn_session` /
`send_session` / `read_session` / `kill_session` / `list_sessions`, their descriptions,
and their zod parameter names (`sessionId` = a worker's CONVERSATION id) are byte-identical
to before, pinned as literals by `session-tools-schema.test.ts`. To the model, a "session"
is still a worker you talk to and a "workspace" is still the environment; that split is a
product decision, not an accident of history, and the internal renames stop at the zod
boundary.

Also unchanged, on purpose: the `pgs-ses-` Sprite-name prefix and the
`agent-session-sprite:v2` HMAC namespace (`workspace-sprite-key.ts`) — both are fold inputs,
so touching either re-derives every live VM's name; the `resourceType: 'agent_session'`
security-audit value, which is recorded history; and the web→realtime shell-activity wire
field, which would need its own accept-both window.

**Compat shims, valid for ONE release — the PR 17 checklist.** This list is the
contract PR's scope, not an illustration of it. Everything here exists only to survive the
deploy window, and PR 17 is the epic's one remaining open task:

*Vocabulary rename (Phase 5)*

1. Updatable Postgres views `agent_sessions` / `agent_session_shells` exposing the old
   column names (`0254_agent_workspaces_rename`).
2. `afterFiles` rewrites aliasing `/api/agent-sessions/**` → `/api/agent-workspaces/**`
   (`apps/web/next.config.ts`).
3. `?session=` still parsed alongside `?workspace=`.
4. `sessionId` still emitted next to `workspaceId` in the session and shell DTOs, and
   still ACCEPTED as a request-body key
   (`api/ai/page-agents/[agentId]/conversations/route.ts`).

*Demoted polls and legacy events (Phases 2–3)*

5. The two 120s backstop polls left behind when the rev-carrying feed became
   authoritative — `AgentsSidebar.tsx` and `AgentPanes.tsx` (`refreshInterval: 120_000`).
6. The legacy `chat:*` emissions and `usePageSocketRoom`, still carried alongside the
   per-conversation rooms (`useAgentChannelMultiplayer.ts`).

The authoritative sweep is `grep -rn 'contract PR'`. It over-matches — some markers belong
to other epics' contract steps — so it is a starting set to triage, not a checklist in
itself. Anything it finds that belongs to THIS epic and is not listed above is a bug in
this list.

The one pair with NO shim is `conversations.sessionId` / `closedInSessionAt` — a table that
keeps its own name leaves no name to hang a view on; see `infrastructure/UPGRADE.md`.

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
3. Schema doc comments (`agent-workspaces.ts`, `conversations.ts`) for per-column
   rationale.

A PR that changes session semantics — a verb's gates, the binding rules, lifecycle
stamps, event emission — must update the contract tests **and** this document in the
same PR. If this document and the code disagree and no test catches it, fixing the
disagreement is the first commit of whatever you were doing.
