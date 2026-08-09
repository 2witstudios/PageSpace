# A server-side close removes the sidebar row again

**Branch** `pu/fix-close-row` · base `pu/workspace-node-model` · spec: `sanity-2026-08-09-10.md` finding 2
**Scope:** the realtime/cache seam only. The node model is untouched; the E2E spec is untouched.

---

## Which half was broken

**Both, in sequence — and the emitter half was the one that made the row immortal.**

### 1. The emitter: `conversation:closed` was not being sent by anything

`emitConversationLifecycle('closed', …)` had **zero production call sites**. The `closed` and
`reopened` branches inside it, and `conversationEvents.closed` / `.reopened` in
`conversation-events.ts`, were live code nobody reached — the only references left in the repo
were the emitter's own definition, the audience test's registry, and the listener waiting for an
event that never came.

How it was established, in order:

| # | Check | Result |
|---|---|---|
| 1 | `grep -rn "emitConversationLifecycle('closed'"` across `apps/`, `packages/` | **no matches** |
| 2 | `grep -rn "conversationEvents\.(closed\|reopened)"` | only `__tests__/conversation-events-audience.test.ts` |
| 3 | `grep -rn "CONVERSATION_EVENTS.closed"` | the emitter definition, the listener, the event-name constant — no producer |
| 4 | Read the close path end to end | `DELETE /api/agent-workspaces/[workspaceId]/conversations/[conversationId]` → `closeConversationInSession` → `closeConversationInSessionWith` → `expel` → `applyWorkspaceMembershipWrite` → `commitUnderLock`. The only broadcast on that path is `broadcastWorkspaceNodesUpdated`. |

The deletion is documented in the code that replaced it. `conversation-repository.ts:718` — the
tombstone comment where `closeConversationListing` / `reopenConversationListing` used to live —
said the directory events "are superseded by the structural `workspace:nodes-updated` broadcast
that write already sends: the fact that moved is the node's location, so the broadcast that
carries the tree is the one that carries it."

**That claim is false, and it is the whole regression.** `workspace:nodes-updated` carries the
tree, into the zustand workspace store. The sidebar's conversation rows are not the tree —
`AgentsSidebar.tsx:610` says so in as many words: the thread list is "keyed by the listing and
never by the tree", read from the `/api/agent-workspaces**` **SWR cache**, which no tree event
touches. Two further facts make the supersession impossible rather than merely wrong:

- `useWorkspaceNodesListener` → `applyRemoteUpdate` "returns immediately for a workspace the store
  is not tracking", and the sidebar lists workspaces the user has never opened;
- the tree event is deliberately structural (no titles, no listing fields), so it could not
  reconstruct a listing row even if it were routed there.

So after the cutover a server-side close removed **no** row until the 120s backstop poll.

### 2. The listener: `closed` had been downgraded from local surgery to a network re-read

`session-directory-listener.ts` handled `conversation:closed` with `handleMembershipChanged` →
`revalidateWorkspaceListings` → `mutate(isAgentWorkspacesKey)` — a bare revalidate, i.e. **a
listing GET**. It was swept into the re-read group with `created`/`deleted` on the reasoning that
the payload no longer names a workspace, so there is no key to aim a patch at.

That reasoning does not survive contact with a *removal*: dropping a row needs to know the
**conversation**, not the workspace, and the cache can find it unaided. So even once the event was
restored, the row would still not have moved under the spec's conditions — the spec blocks the
listing fetch at the network precisely so that a re-read cannot pass for a fix.

The unit test at `session-directory-listener.test.ts:169` **asserted the regression**
(`'%s should re-read the session listings'` over `closed`/`deleted`). That is why no unit suite
caught this: the one test covering the handler had been updated to match the broken behaviour, and
the no-refetch contract existed only in E2E.

---

## What changed

Nine files, +368/−43. No node-model file and no E2E file among them.

**Emitter side — the announcement restored at the new chokepoint**

- `close-conversation-in-workspace.ts` — the pure decider gains an injected `announceClosed(row)`
  dep, called **only** on the `dismissed` branch and **after** the membership write. It lives here
  rather than in the caller because this function is the only place that knows a close actually
  happened; every other answer it gives is a refusal wearing the same `not_in_session` shape.
  Deps are now generic over the row the caller's read returns (`ConversationCloseSubject` is the
  minimum this module gates on), so the wiring can pass its emit context straight through.
- `reopen-conversation-in-workspace.ts` — the mirror, `announceReopened`. Included because both
  call sites were deleted by the same commit and the listener's `reopened` handler is still there,
  correct, and unreachable; leaving it dead would be the same bug pointing the other way.
- `agent-workspaces-runtime.ts` — wires both to `emitConversationLifecycle('closed'|'reopened', row)`
  and widens `conversationOwnerRead`'s projection from `{userId, isActive}` to the full
  `BumpedConversationRow`. That read already runs on both paths for the ownership gate, so the
  emit context costs no extra query. **`rev` is passed through unbumped, deliberately** — it is the
  message plane's watermark and a membership change writes no message; bumping it would make every
  subscribed pane detect a gap and refetch a transcript that did not change.
- `conversation-repository.ts` — the "superseded by the structural broadcast" comment is replaced
  with what actually happened, so the same wrong inference is not drawn again.

**Listener side — the no-request path restored**

- `workspace-conversations.ts` — `forgetConversationInCache(mutate, sessionId: string | null, conversationId)`.
  `null` means "whichever workspace holds it". That is not a widening: the node table's global
  chat-target uniqueness means a thread is a member of **at most one** workspace, so at most one
  row can match — the same sweep `touchConversationInCache` already does for the same reason. The
  sidebar's own optimistic close still passes its workspace id, keeping that write as narrow as its
  knowledge.
- `session-directory-listener.ts` — `conversation:closed` gets its own handler doing a local,
  `{revalidate: false}` drop. `deleted` keeps its re-read (a history delete changes more than one
  listing row, and no spec asks it to survive a blocked network).

---

## Tests added at unit level

The seam had no unit coverage in either direction, which is why only E2E caught it. Both
directions are now covered.

**Emitter half** — `__tests__/close-conversation-in-workspace.test.ts`, new
`describe('the directory announcement')`:
announces a real close with the row it gated on; announces **after** the membership write, never
before (ordering asserted explicitly — announcing a close the write then refuses reads as "the row
vanished and came back"); stays silent for `not_a_member`, `refused`, a non-owner, a
history-deleted thread, and a nonexistent id. Mirror block added to
`reopen-conversation-in-workspace.test.ts`.

**Listener half** — `__tests__/session-directory-listener.test.ts`, the block that asserted the
regression is replaced by `conversation:closed — served locally, with no request at all`: the
updater is a function **and** the options are exactly `{revalidate: false}` (a one-argument
`mutate` is the regression); the closed row goes and its siblings stay; a session that does not
hold the conversation is untouched; an unloaded cache entry writes nothing rather than throwing.

### Mutation checks — each new test broken deliberately and observed red

| Mutation | Result |
|---|---|
| listener `closed` → back to `handleMembershipChanged` (re-read) | **5 failed**, incl. all 4 new `conversation:closed` tests |
| `deps.announceClosed(row)` deleted from the decider | **2 failed** (`announces a close…`, `announces AFTER…`) |
| `announceClosed:` wiring dropped from `agent-workspaces-runtime.ts` | **typecheck error TS2345**, exit 2 — the dep is required, so the wiring cannot silently regress again |

---

## Test results

**Unit — all green.**

| Command | Result |
|---|---|
| `bun run --filter web test -- src/lib/realtime` | **6 files, 137 passed** |
| `bun run --filter web test -- src/components/layout/left-sidebar` | **6 files, 94 passed** |
| affected sweep (`src/lib/realtime`, both deciders, `src/lib/websocket`, `src/components/agents/panes`) | **21 files, 523 passed** |
| `bun run --filter web typecheck` | exit **0** |
| `bun run --filter web lint` | exit **0** (pre-existing warnings only, none in touched files) |

`bun run --filter web test -- src/lib/agent-workspaces`: **11 files / 167 tests passed, 6 files
failed** — every failure is an `*.integration.test.ts` aborting on
`could not reach DATABASE_URL`, the known worktree env gap. Both decider suites are in the passing
set (close 14, reopen 13).

**E2E — NOT RUN HERE, and that is the verification that matters.**

`18-sidebar-directory-live.spec.ts` needs a running app (`playwright.config.ts` `webServer`,
`baseURL` :3000) and a migrated database, neither of which this worktree has. The unit coverage
added above spans the seam in both directions and dies when either half is reverted — but the
defect was found by E2E, and only E2E exercises the realtime event against a network-blocked
listing fetch end to end.

`ci / E2E (agent-session user stories)` on the cutover PR is the authority. This fix is unverified
against the failing spec until that job is read.

---

## Notes for whoever picks this up

- The `reopen` emit is restored in the same change. There is no E2E covering it, so it is verified
  at unit level only.
- `conversation:deleted` still answers with a re-read. That is a deliberate, stated choice rather
  than an oversight — see the listener's doc.

Nothing was merged and no PR was opened.
