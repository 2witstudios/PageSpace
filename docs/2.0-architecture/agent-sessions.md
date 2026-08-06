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
- **Pane grid**: today `agent_sessions.workspaceState` is one jsonb blob written only by
  the client's debounced sync (`PUT /api/agent-sessions/{id}/workspace`) / target:
  relational pane tables + rev counter + idempotent verbs, server-authoritative, with
  the blob dying at contract (epic Phase 3, the #2202 machine-panes pattern).

## 2. Authorization axioms (PR #2336 — product-locked)

These are product decisions, not implementation accidents. They supersede issue #2262
finding 1's workspace confinement.

1. **Verbs are resource-addressed and permission-gated, like `read_page`.**
   `send_session` / `read_session` / `kill_session` authorize against the resource:
   the caller owns the worker conversation, it is actually a worker (bound into some
   workspace), and its listing is not human-closed. All three refuse identically —
   nothing to learn from the difference. The calling conversation plays no
   authorization role and is not required. (Page-worker dispatch additionally
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
   the caller's workspaces, every worker everywhere addressable by the verbs. The
   advisory cap pre-count applies only to own-workspace spawns — a full caller
   workspace can't refuse a spawn aimed somewhere with room.

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
   broadcast. *Today:* ~10 call sites save messages directly and membership facts are
   stored three ways (FK, `workspaceState` jsonb, localStorage). *Target:* epic
   Phases 2–3.
2. **Every owner emits on write.** Each committed write broadcasts a rev-carrying event
   (`conversations.rev` bumped in-transaction; the event carries the post-write rev).
   *Today:* nothing broadcasts on message persistence — only the stream lifecycle
   emits, and the `chat:user_message` broadcast is gated on `isShared`, so a user's own
   server-side dispatch is invisible to their own open panes. *Target:* epic Phase 2.
3. **Every surface is a subscriber that can prove it is current.** Pane, sidebar, and
   agent alike hold a rev watermark; an event with `rev == watermark + 1` applies, a
   gap triggers a snapshot refetch, reconnect runs a batched rev check. Transport stays
   best-effort; correctness comes from rev + refetch, not delivery guarantees.
   *Today:* caches apply events only for conversations already loaded and lists heal by
   15–20s polls. *Target:* epic Phases 2–4; polls demoted to backstops.
4. **A tool action and a UI action are indistinguishable to every observer — including
   the acting agent.** A server-side `send_session` dispatch and a pane's own POST take
   the same write path, emit the same events, and appear live in the same surfaces.
   Read-your-writes holds for agents too: an agent that just wrote through a tool can
   immediately observe its own write through any read path.

The acceptance criterion, one sentence: **if a feature needs a second copy of a fact, it
derives at read time or it doesn't ship.** Forced copies get drift-guards; dual-writes
get one shared writer.

## 4. Vocabulary

"sessionId" has carried five meanings. The canonical names:

| Canonical name | What it is | Where "sessionId" meant this |
|---|---|---|
| `workspaceId` | An `agent_sessions` row — the working context / sandbox owner | Everywhere except the tool layer: `conversations.sessionId`, `agent_session_shells.sessionId`, `/api/agent-sessions/[sessionId]`, `?session=` URLs |
| `conversationId` | A thread (`conversations` row) | The session-tool layer: the `sessionId` param of `send_session` / `read_session` / `kill_session` is a **worker's conversation id** (`apps/web/src/lib/ai/tools/session-tools.ts`, where `workspaceSessionId` is the workspace) |
| *(frozen)* `sessionId` | The model-facing tool param | The wire vocabulary is deliberately frozen at the zod boundary: to the model, a "session" is a worker you talk to and a "workspace" is the environment. Internal renames never touch these schemas |
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

1. **The contract tests** *(forthcoming — epic Phase 1, task "Tool contract pin and
   typed refusals")*: snapshot tests pinning the model-facing tool JSON schemas, plus
   tests pinning each tool description's behavioral claims to the code that enforces
   them. Once landed, a description that drifts from behavior fails CI instead of
   shipping.
2. **This document** for the model and the axioms.
3. Schema doc comments (`agent-sessions.ts`, `conversations.ts`) for per-column
   rationale.

A PR that changes session semantics — a verb's gates, the binding rules, lifecycle
stamps, event emission — must update the contract tests **and** this document in the
same PR. If this document and the code disagree and no test catches it, fixing the
disagreement is the first commit of whatever you were doing.
