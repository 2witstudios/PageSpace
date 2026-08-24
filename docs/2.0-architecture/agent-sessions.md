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

> **`envId` — owning versus borrowing a sandbox.** The schema now carries a nullable
> `agent_workspaces.envId` pointing at a `drive_envs` row: a *persistent, drive-owned*
> ENVIRONMENT that sessions can be spawned inside (epic "Deliberate Per-Drive
> Environments"). The column is **written now** — #2450 gave environments a surface and
> #2452 moved creating one into the spawn palette, so a session started "in" an
> environment carries its id. Everything below still describes every session that does
> not: an ephemeral, self-owned sandbox remains the default and the common case.
>
> What changes when it is written: an env-bound session **borrows** its env's sandbox
> instead of owning one, so it holds no Sprite pointer of its own. That is enforced by
> the database, not by convention (`agent_workspaces_env_no_sprite_check`), which is what
> makes "ending an env session cannot kill the env" structural: the lifecycle planner sees
> `sandboxId IS NULL` and stamps `endedAt`, killing nothing. Ephemeral per-session
> sandboxes remain the default and are unchanged.
>
> **An env owns its sessions.** `envId` is `ON DELETE CASCADE`: deleting an env deletes
> the sessions run inside it, their panes, that tree's rev counter and their shells —
> everything that already cascades from a session row. It does **not** reach chat
> history, because nothing connects the two: `conversations` lost its session column at
> `0256` and a pane's `targetId` is polymorphic with no foreign key, so conversations are
> independent rows that stay reachable through the cross-session past-conversations
> surface. What a cascade destroys is layout and shell scrollback, not threads. Nor is
> any accounting lost — an env-bound session is CHECK-forbidden from holding Sprite or
> storage/billing columns, so the row carries no VM to orphan and no bytes to bill.
>
> **There is no env "kind".** dev / staging / prod are use cases a user expresses by
> NAMING an env; every env is Sprite-backed uniformly. The Fly serving tier attaches
> later as a `published_apps.envId` hosting row pointing AT an env — it never puts Fly
> pointers on the env row.

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
  :caller`; `apps/web/src/lib/agent-workspaces/claim-conversation-in-workspace.ts`). No
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

- **Pane lifecycle (issues #2462, #2469, #2473): SHIPPED.** Three corrections
  from one real working session, all in the same subsystem, all found by USING
  it:
  - **A shell's pane goes with the shell.** `kill_shell` — and the DELETE the
    tab's close button sends — expels the node bound to `{kind: 'terminal', id}`
    in the SAME transaction that kills the PTY and drops the row, mirroring
    `spawnShell`'s admission. It used to write to the tree not at all, so a
    killed shell left a pane bound to a terminal that no longer existed, with
    no broadcast and no repair short of a human closing it. A kill that cannot
    reach the process unwinds the node write rather than removing a live PTY's
    only surface.
  - **Placement chooses its direction from the layout, and packs where packing
    costs nothing.** `OpenInput.axis` defaulted to `row` and no production caller
    ever supplied one, so every agent-opened pane became another column. A
    placement now takes the pane with the most room and divides it along its
    longer edge (`workspace-node-packing.ts`), and where the direction matches
    the container it is in it PACKS into that container instead of nesting a new
    one — which is what stops repeated opens from walking toward `MAX_DEPTH`.
    Two conditions, both about not moving something somebody chose: only the
    PLACEMENT path packs (the toolbar's split still divides the pane the user
    pointed at), and only into a container NOBODY HAS SIZED, since joining a
    sibling group means being rebalanced into it. The remaining cost is named
    where it is paid: a packed split and a concurrent remote insert want the same
    slot, so the loser's optimistic write is dropped whole and announced
    (`queueErrors: 'superseded'`), where a nesting split survived.
  - **`spawn_shell` and `kill_shell` report the layout.** `paneNodeId` (the
    pane opened, or the one closed) and `paneCount` (and, at six panes or more,
    a note) ride the responses an agent already reads. `list_panes` was always
    there and the session that filed #2469 never called it: nothing gave it a
    reason to look. `close_pane` now says what it does to a TERMINAL pane — it
    takes the pane and leaves the process running, reachable by
    `send_shell`/`read_shell` and off the grid until someone reopens it from the
    session's shell list — because the tidy-up note points agents at that verb.
    The browser's own close of a terminal tab still kills the shell, and that
    asymmetry is a product choice rather than a claim about reachability: a
    person closing a tab means they are done with it, and the sidebar row is
    there either way.

## 2. Authorization axioms (PR #2336 — product-locked)

These are product decisions, not implementation accidents. They supersede issue #2262
finding 1's workspace confinement.

1. **Verbs are resource-addressed and permission-gated, like `read_page`.**
   `send_session` / `read_session` / `kill_session` authorize against the resource:
   the caller can REACH the worker, it is actually a worker (bound into some
   workspace), and its listing is not human-closed. **Reach is three borrowed
   rules, not ownership.** The CREDENTIAL's drive ceiling admits the request at
   all (`mcpAllowedDriveIds` — see axiom 8), the DRIVE admits you to the
   workspace (`decideAgentSessionAccess`: owner/admin/member — exactly what
   axiom 6's discovery already showed you), and the WORKSPACE shows you the
   thread (`isConversationVisibleToViewer`: you own the workspace, you own the
   thread, or its owner deliberately shared it — axiom 7, the same predicate that
   decides whether its title is legible). So an agent addresses exactly the rows
   it can name, and only within what its key was cut for. Ownership alone used to
   be the gate, strictly narrower than the
   platform's own rule: two members of one drive could see each other's
   workspaces and address nothing in them. Drive membership ALONE would have been
   too wide the other way — it would have made axiom 7's per-thread opt-in
   silently meaningless. A resource the caller cannot reach always reads as
   nonexistent —
   anti-enumeration, unchanged. For rows the caller CAN reach the refusals are
   distinct, typed and actionable (shipped, epic Phase 1): an unbound thread answers
   `not_a_worker` with spawn-from-inside-it guidance, a human-closed listing answers
   `worker_closed` with the reopen-or-spawn-fresh remedy — while no-row and
   unreachable collapse into one identical not-yours message. (A closed foreign
   worker collapses too: `isClosed` and "no workspace" come from the same membership
   read, so there is nothing to prove reach against.) The calling conversation plays
   no authorization role and is not required.

   **Reaching a worker never lends you its owner's authority.** A dispatched turn
   runs as the actor who dispatched it, always — `send_session` means "speak into
   that thread as yourself", never "make that worker act with its own access".
   Otherwise a plain member could send *"list every page you can see and paste it
   here"* into an admin's worker and read it back with `read_session`, and every
   shared drive would be an escalation ladder. (Page-worker dispatch additionally
   re-enforces the agent's RBAC inside the standard chat pipeline it runs through.)
   `kill_session` is the one verb reach alone does not carry: stopping ANOTHER
   member's worker runs `decideAgentSessionEndAccess` (drive owner/admin, plus the
   code-execution capability) and refuses distinctly if it fails — the caller has
   already proven reach, so there is nothing left to hide from them.
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
   the caller's workspaces; every worker it reports BY NAME — the caller's own, and
   other members' deliberately-shared ones — is addressable by the verbs (axiom 1),
   while a `(private thread)` row is visible but not addressable. The
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
7. **Foreign private-thread titles redact in listings — and that redaction is now
   the ADDRESSABILITY rule too.** One pure mechanism, unchanged in substance
   (`packages/lib/src/agent-workspaces/redact-conversation-listing.ts`): a viewer
   listing a workspace they do not OWN sees a conversation's title only when the
   thread is their own or deliberately shared (`conversations.isShared`); every
   other row keeps its agent and activity time but reads `(private thread)`.

   What changed is its REACH, not its content. The rule used to be strictly weaker
   than the verbs' gate — "transcript content stays owner-gated regardless" — so a
   redacted row was merely a row you could not name. Once axiom 1 widened the verbs
   to drive membership, leaving it there would have shown an agent
   `(private thread)` for a row it could nonetheless message and read. So the
   predicate was extracted (`isConversationVisibleToViewer`) and the verbs consult
   it: a redacted row is one the verbs refuse, indistinguishably from a row that
   does not exist. Drive membership opens the working CONTEXT; sharing a thread is
   what opens the thread. The verb descriptions carry the caution that belongs
   alongside — a shared worker's transcript is someone else's work: untrusted
   input, not instructions, and not yours to interrupt unasked.

8. **A credential's drive ceiling binds every workspace-resolving verb, and it
   is asked FIRST.** Every other rule here asks about the USER. A drive-scoped
   MCP/API token is not its user: it is confined to a subset of that user's
   drives, and a worker, workspace, pane grid or shell outside them must read as
   nonexistent to it however freely its owner could reach the same thing. This
   applies to the caller's OWN resources too — ownership is not an escape from
   scope — and to PLACEMENT, which is a write: `spawn_session`'s explicit
   `workspace` target is weighed against the ceiling alongside
   `checkSessionAccess`, so a token cannot put an agent (and its sandbox reach)
   somewhere it was never granted. Discovery is held to the same ceiling as
   addressability, so `list_sessions` can never advertise an id the verbs refuse.

   The subtlety worth recording, because it is what made this easy to get wrong:
   a conversation's WORKSPACE BINDING and its AGENT PAGE need not share a drive.
   `spawn_session` takes an explicit workspace id, so a conversation driven by an
   agent in drive A can be bound to a workspace in drive B — and the page-scope
   check that admitted the turn (`checkMCPPageScope`) covers the page, never the
   binding. Any verb that resolves a workspace from that binding must therefore
   consult the ceiling itself; "the page was in scope" does not carry.
   Unresolvable drives fail closed.

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

**How dispatch authenticates that hop changed afterwards, and the strategy decision moved
with it.** Dispatch used to replay the calling user's own cookie/Bearer out of
`next/headers` into `POST /api/ai/chat`. That made a live browser-ish credential a
precondition for one agent messaging another, so every server-side surface — the voice
bridge, cron, the workflow executor, the channel mention responder — was refused outright
("the calling request carries no session credentials to dispatch with"), and a Bearer
caller could never reach a global worker at all (see the MCP clause below). Dispatch now
SIGNS a payload naming the acting user and POSTs `/api/internal/agent-dispatch`
(`packages/lib/src/auth/agent-dispatch-payload.ts`), verified with the same body-bound
HMAC `/api/broadcast`, `/api/realtime/attach` and `/api/internal/voice/bridge` already
use — a signature authenticates the SERVICE, never the user, and the acting user is
re-read live (suspension binds on the hop). The strategy decision was extracted from
`handleChatTurn` as `dispatchChatTurn` so the internal route reaches the SAME decision
rather than growing a second one. Two things ride the signed payload because losing them
would silently widen: the chain DEPTH (so the recursion cap cannot be reset by a forged
header) and the originating credential's DRIVE CEILING (so a scoped MCP token's worker
cannot come out of the hop unscoped — see the service branch in `getAllowedDriveIds`).

`/api/ai/chat` therefore accepts one shape it used to refuse: a request with no `chatId`
whose `conversationId` resolves to **the caller's own** existing global-assistant
conversation. That is the whole widening, it is fail-closed (the global strategy
independently re-checks owner + `type='global'` + `isActive`), and an MCP token still
cannot reach the global assistant through **that public URL** — MCP has never been able to
drive the global assistant and the entry refuses with the same answer the session-only
route always gave.

`/api/internal/agent-dispatch` deliberately does not inherit that refusal, which is what
lets an SDK, CLI or Claude Code caller on an API key drive a global worker. The public
URL's refusal is a policy about untrusted bearer clients naming an arbitrary conversation
id; a dispatch is not that — the tool layer already resolved the target and authorized the
actor against it, and the body is signed. The ownership clause below still gates who the
actor may be.

The ownership clause is load-bearing for a reason unrelated to access, and was added by
review: without it, someone else's global conversation routed to the global strategy and
came back `404`, while every other id fell through to `400 "chatId is required"` — an
existence oracle over conversation ids, in a codebase that refuses uniformly across
"forbidden" and "does not exist" everywhere else it decides anything.

**Two strategies, not one merged function, and deliberately so.** Beyond the shared
prologue the two turns genuinely differ — the authorization subject (agent page vs
conversation), MCP drive scoping, conversation minting rules, the tool set (per-agent
allowlist and sandbox gating vs always-search-mode), system-prompt construction, the
credit path (page chat aborts mid-stream on exhaustion), provider admission order, the
history seam, @mention notification, the realtime gates, and usage telemetry. Collapsing
those into one function would mean twenty conditionals in the app's highest-risk path,
several of them security decisions. The table of divergences is maintained in the entry's
own docblock; the stretch with the worst failure mode — takeover, stream lifecycle and the
`'streaming'` placeholder under a per-conversation advisory lock — is shared outright in
`start-chat-generation.ts`, because a lock protocol maintained twice is a lock protocol
that drifts into double generation and double billing.

**What "one pipeline" does NOT mean, and this section used to imply.** It names the ENTRY.
It says nothing about the two strategy functions, and they are neither small nor DRY:
`runPageChatTurn` is ~2,080 lines in one function and `runGlobalChatTurn` ~1,460, with
**162 substantive lines of 40+ characters byte-identical between them** — measured, and
clustered rather than scattered, in the epilogue (stream construction, `onFinish`,
terminal persist, hold settle, telemetry), which is also where the billing settle,
`releaseHold` and the exactly-once mention latch live. Two copies of the money path. That
they drift is on this branch's own record: `5c1bc5410`, "bring the global assistant to
parity with the page chat".

This section previously said the one duplicated stretch had been shared outright, which
read as a claim that the rest was merely similar. It is not. The epic relocated this code
out of `route.ts` and thinned the route to ~30 lines without rewriting the function it
moved, and §5's rule — a description the code no longer enforces is worse than no
description — applies to this document as much as to a tool docblock. The extraction that
would pay first is the epilogue behind a typed turn context; it is a follow-up, not a
claim already banked. Full measurement and line ranges are in `handle-chat-turn.ts`'s
docblock, next to the divergence table that argues (still correctly) against merging the
strategies themselves.

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
the new joins, and the new handlers idle until it reloads. Nothing depends on web-first,
and both services deploy after the migration step they share.

**Amended by the voice bridge.** This section used to add "realtime makes no outbound HTTP
calls to web at all (`WEB_APP_URL` is a CORS origin)" as a supporting fact. That stopped
being true when audio-native voice landed: `apps/realtime` holds the OpenAI realtime socket
for the life of a call and calls **back** into web at `/api/internal/voice/bridge`
(`VOICE_CALLBACK_ROUTES`) to run tools and persist transcripts, because the tool registry
and `messageRepository` live in web and cannot move. The ORDERING is unchanged — new
realtime against old web is still the benign direction — because every hop on that bridge
is best-effort per call: an unrecognised route answers 404, the client reports a failure,
and the call degrades to audio without tools or transcripts rather than dropping. Metering
is unaffected either way; it runs inside `apps/realtime` against `@pagespace/lib` and
crosses no process boundary.

### 3e. A spawn never starts a crippled worker

`pages.enabledTools` is an ALLOWLIST, not a grant. Downstream of it the page pipeline
applies gates the allowlist cannot re-open — chiefly the per-agent sandbox switch
(`pages.sandboxEnabled`, `filterToolsForSandboxEnablement`), which strips the whole
sandbox family (bash/files, git+gh, sessions/shells) whatever the allowlist says, and then
the payer-tier gate and the exposure mode.

Issue #2460 is what that costs when nothing says so. An agent configured entirely through
`update_agent_config` — where `sandboxEnabled` was not even a parameter, the one agent
field the settings UI could write and tools could not — stored 24 tool names including
`bash`, `readFile` and `spawn_shell`, had them echoed back intact on every write, and
spawned worker after worker with page tools only. No spawn failed. The workers simply
could not do the job, and each landed on a different surface (workspace placement decides
tier eligibility), so the divergence read as randomness.

Three rules now hold, and `agent-tool-surface.ts` is the single place that computes them:

1. `update_agent_config` writes `sandboxEnabled`, gated on the same plain edit access
   `PATCH /api/pages/[pageId]/agent-config` uses — one field, two doors, one policy. The
   gate itself is untouched: it is settable and visible now, not weaker.
2. `update_agent_config` echoes the EFFECTIVE surface beside the stored one
   (`effectiveTools`, `blockedTools` with the gate that dropped each,
   `toolsReachedBySearch`), plus a warning sentence per divergence. Confirming a stored
   list that grants nothing is the lie §5 is about.
3. `spawn_session` REFUSES (`reason: 'agent_tools_ungrantable'`) when the agent's own
   config contradicts itself — sandbox tools named while its `sandboxEnabled` switch is
   off. That is deterministic and one call fixes it either way. Drops the caller cannot
   fix (a name this deployment does not register) and `'search'`-mode deferral do NOT
   refuse: they ride the success payload as `toolSurfaceWarnings`, because refusing there
   would break working spawns over a non-problem.

`'search'` exposure defers non-core tools behind `tool_search`/`execute_tool` without
losing them. It is worth naming because a search-mode agent LOOKS like an agent with page
tools only — which is how #2460 was first misread — and because a deferral reported as a
block would send the next reader after the wrong fix.

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

**NOT renamed, and NOT frozen either — the honest third category** (review finding). The
rename reached the tables, columns, module directories, routes and the store internals. It
did **not** reach the exported type vocabulary or the client component layer, and until now
this section listed only "renamed" and "frozen", which left a reader to conclude that
anything not called out as frozen had been done. It had not:

- ~30 exported names still spelled `AgentSession*` — `AgentSessionRecord` (38 references),
  `AgentSessionRowStamps` (17), `AgentSessionListFilter` (17), `AgentSessionStore` (15),
  `AgentSessionDTO` (9), plus `spawnAgentSession` / `endAgentSession` / `listAgentSessions`
  and the DTO schema.
- The wire still says `session`: `GET /api/agent-workspaces/[workspaceId]` returns
  `{ session: … }`, and `useSessionRecord(sessionId)` fetches a workspace URL for a
  workspace id held in a variable named `sessionId`.
- `agent-workspaces-runtime.ts` re-exports `MAX_ACTIVE_WORKSPACES_PER_OWNER` under the old
  name, for callers not yet moved.
- The component layer is untouched: `SessionPanes.tsx`, `useSessionRecord.ts`,
  `useSpawnSession.tsx`, `EndSessionDialog.tsx`, and locals/props that name a WORKSPACE id
  `sessionId` — producing lines like `session.workspaceId === sessionId`, where the next
  reader has to prove to themselves that this `sessionId` is not the deprecated column.
- This document's own filename.

None of that is a bug and none of it is a compat shim, so it belongs on neither list above.
It is unfinished work, and the reason to write it down rather than sweep it now is that
this epic's diff is already ~570 files: a mechanical rename through the client layer at
this point buys naming and costs review attention on the surfaces that carry behaviour
changes. §5's rule cuts both ways — the danger is a claim the code does not honour, and
"Phase 5 renamed the vocabulary" was becoming one.

The standard to meet is `session-tools.ts`'s: it freezes `sessionId` on the wire *and says
so, at the point of use*, twice. Everything above should either reach that bar or finish
the rename. Tracked as Phase 5's remainder on the epic board.

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

**Deferred work that is NOT a shim — also PR 17's, for want of anywhere else.** These are
not compat surfaces to delete; they are things this epic left owed. They are listed here
because the alternative is where they were: a migration header pointing at a PR that came
and went, and a `Set` inside a unit test. Both were found by review, not by the list.

7. **The four `NOT VALID` constraints from `0250_cooing_klaw`** —
   `ai_stream_sessions_conversation_id_conversations_id_fk`,
   `conversations_global_context_null_chk`, `conversations_page_context_present_chk`,
   `conversations_drive_context_present_chk`. 0250's own header defers `VALIDATE
   CONSTRAINT` to "the PR that has looked at real data (Phase 4 PR 14)", and PR 14
   (`0251_messages_unification_validate_fk`) validated only 0249's `chat_messages` FK — on
   a table 0253 then dropped. `grep -rn 'VALIDATE CONSTRAINT' packages/db/drizzle/` returns
   exactly one executable statement, and none of these four. Until they are validated,
   pre-0250 rows that already violate them stay: `purge-stream-state.ts` records the
   concrete consequence — `ai_stream_sessions` rows whose conversation was hard-deleted
   before 0250 landed dangle with no cascade to ride, and they carry `parts`. Article 17
   erasure compensates with a user-scoped delete, so erasure is covered; the
   CONVERSATION-scoped retention purge (`retention-engine.ts`) is not. `VALIDATE` takes
   only `SHARE UPDATE EXCLUSIVE`, and 0250's pre-audit NOTICE already reports the counts
   an operator needs first.
8. **Rich renderers for the four pane-grid verbs** — `list_panes`, `resize_pane`,
   `move_pane`, `arrange_panes`, all new in this epic and all currently rendering to the
   user as raw payloads. Tracked in `PENDING_RICH_RENDERERS` in
   `registry-coverage.test.ts`, which fails in both directions and cannot grow silently —
   but a ledger inside a test stops CI forgetting, not the epic. The stated reason for the
   deferral (a grid card is a layout-diagram design task, not a formatting one) stands;
   it just needs an owner outside the test file.

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
