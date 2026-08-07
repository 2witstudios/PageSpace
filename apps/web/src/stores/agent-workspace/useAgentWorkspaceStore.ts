import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import {
  persistedColumnStateSchema,
  type PaneScope,
  type PersistedColumnState,
} from '@pagespace/lib/agent-sessions/contract';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import {
  applyVerbLocal,
  isLastPane,
  paneShowing,
  panesOf,
  type PaneState,
  type WorkspaceLayoutVerb,
  type WorkspaceState,
} from './pane-reducer';
import { adoptServerGrid, replayPending, type PendingVerbOp } from './verb-queue';

/**
 * Where each session's pane layout lives — as a DERIVED CACHE of the server's
 * relational grid, not as its own source of truth (epic Phase 3, the #2202
 * machine-panes pattern).
 *
 * **The equation.** For every session this store holds a server snapshot
 * (`base` + `rev`) and a FIFO of verbs applied locally but not yet
 * acknowledged; what components render is always
 * `replayPending(base, pending)` (`verb-queue.ts`). Every mutating action
 * reduces through the SHARED reducer (`applyVerbLocal`, which the server's
 * verb engine runs too — one function, two callers), enqueues the verb, and
 * POSTs it EAGERLY, one at a time, in order:
 *
 *   - **200** → the op landed (or replayed, or no-oped): drop it from the
 *     queue and adopt the returned `{rev, grid}` as the new snapshot —
 *     including when `applied: false`, because a no-op still tells us the
 *     current truth, and refusing it would leave the client one rev behind
 *     forever and 409 on everything after.
 *   - **409** → `baseRev` was stale: the body IS the truth. Adopt it, replay
 *     everything still unacked (the 409'd op included — it did not land),
 *     and re-POST from the head with the new rev.
 *   - **`workspace:updated`** (another device, or a server-side AI placement)
 *     → drop if `rev <= known`; no-op if it carries an opId we still have in
 *     flight (our own echo — our POST's own answer is the authoritative one
 *     and is already on its way); otherwise adopt + replay.
 *
 * **What this replaced, and why it is gone.** The blob era arbitrated between
 * three copies of the same fact with a debounced PUT, two hydration latches
 * (`hydratedSessionsThisPageLoad`, `adoptServerWorkspaceAsHydrated`) and a
 * localStorage copy of the grid. All of it existed to answer "who wins?" —
 * a question a rev + a replayable queue answers structurally. A stale local
 * seed no longer needs a latch to protect it: it simply 409s once and
 * rebases. THE GRID IS NO LONGER PERSISTED LOCALLY.
 *
 * **What is still client-local**, and the only thing localStorage still
 * holds: `activePaneId` and `pendingPickerPaneId`. Focus is view state no row
 * owns (per #2048, deliberately not restored cross-device), so it is kept
 * beside the cache and overlaid on every snapshot that arrives — a remote
 * edit never steals your focus, and a pane that vanished falls back to the
 * first one.
 *
 * **Client-only guards stay client-only.** `openConversation`/`openPage`
 * refuse to evict a pane with unsaved edits (`useEditingStore` via
 * {@link isPaneDirty}), a non-live conversation or a page pane (issue #2295),
 * a running terminal, or the invoking conversation's own pane. The server
 * cannot evaluate any of those, so this store does NOT emit the server's
 * policy verb (`open_conversation`) — it resolves the policy here and posts
 * the RESULT (`assign_pane`, or `split_right` + `assign_pane`). Server-driven
 * placement uses `open_conversation` with its own narrowings.
 *
 * Keyed by SESSION id: the session is the workspace unit (it owns the sandbox
 * every pane shares).
 *
 * **A session is never empty, in both directions.** It is born with its first
 * conversation in its first pane, and closing the LAST pane is intercepted
 * HERE — the store forgets the grid and reports it, so the caller can end the
 * session (tear down its sandbox) as the same act. No `close_pane` verb is
 * sent for it: emptying a session is a lifecycle act (the end route), never a
 * layout verb, which is exactly why the shared reducer no-ops on it.
 */

/** Focus — the only pane-grid state that is still client-local (and still persisted). */
interface WorkspaceFocus {
  activePaneId: string;
  pendingPickerPaneId: string | null;
}

/** One session's cache bookkeeping. Never read by components; the derived `workspaces` map is. */
interface WorkspaceSync {
  /** The last server snapshot. `null` = the server has no grid for this session. */
  base: WorkspaceState | null;
  /** The rev `base` was read at — what the next POST rebases on. */
  rev: number;
  /** Verbs applied locally, awaiting their POST. Strictly FIFO. */
  pending: PendingVerbOp[];
  /** The opId currently on the wire, if any — the serial-send guard. */
  inFlight: string | null;
  /** Consecutive transport failures for the head op; resets on any settled answer. */
  attempts: number;
}

interface AgentWorkspaceState {
  /** sessionId → what to render. Derived: `replayPending(base, pending)` plus the focus overlay. */
  workspaces: Record<string, WorkspaceState>;
  /** sessionId → the server snapshot + unacked queue behind it. */
  sync: Record<string, WorkspaceSync>;
  /** sessionId → client-local focus. The ONLY thing this store persists. */
  focus: Record<string, WorkspaceFocus>;

  /** Give a session its opening grid, once. Idempotent. */
  ensureWorkspace(sessionId: string, scope: PaneScope): void;
  /**
   * Make a conversation VISIBLE in the session's grid — what a sidebar or
   * history selection means. Focus the pane already showing it; otherwise
   * open it in the active pane when that pane is replaceable, or in the first
   * replaceable pane — never over a TERMINAL (a running PTY loses its only
   * surface; there is no reattach UI), never over unsaved edits. With nothing
   * replaceable, split the active pane right.
   *
   * `options.liveConversationIds`, when supplied, additionally protects a
   * chat pane whose target is NOT in that set — e.g. a conversation the user
   * closed out of this session (`closedInSessionAt`) — AND any page pane (a
   * deliberate, persisted artifact; a reload's seed effect used to silently
   * evict agent-opened pages this way) from an unrelated later selection
   * (issue #2295); both fall through to the split fallback instead, exactly
   * like a terminal/dirty pane does. Omitted (any caller that hasn't learned
   * the live set yet), behavior is unchanged — this guard is strictly
   * additive.
   */
  openConversation(
    sessionId: string,
    scope: PaneScope,
    options?: { liveConversationIds?: ReadonlySet<string> },
  ): void;
  /**
   * Make a PAGE visible in the session's grid — the page-pane sibling of
   * `openConversation`, sharing its focus-or-replace-or-split policy with two
   * extra guards (a page pane can hold unsaved edits, and can itself BE the
   * conversation that asked to open it): `excludeTargetId` (the invoking
   * conversation's own id, for the agent-driven `open_page_pane` path) is
   * never replaced, and `options.preferSplit` (that same agent-driven path)
   * evicts nothing bound at all — an agent ADDS a surface beside what the
   * user is doing, it never navigates. Used by the picker's "Pages" section
   * and by `useOpenPagePane`'s resolution.
   */
  openPage(
    sessionId: string,
    scope: PaneScope,
    options?: { excludeTargetId?: string; preferSplit?: boolean },
  ): void;
  splitRight(sessionId: string, fromPaneId: string): void;
  splitDown(sessionId: string, fromPaneId: string): void;
  /**
   * Close a pane. Closing the LAST pane removes the whole grid and returns
   * `'session-ended'` — the caller owns the IO that ends the session; the
   * store owns only the layout fact.
   */
  closePane(sessionId: string, paneId: string): 'closed' | 'session-ended' | 'noop';
  /** Focus a pane. CLIENT-LOCAL — focus is not a row, so no verb crosses the wire. */
  selectPane(sessionId: string, paneId: string): void;
  assignPane(sessionId: string, paneId: string, scope: PaneScope): void;
  /** Unbind a pane back to the picker — a failed mint, first-class rather than a sentinel scope. */
  resetPane(sessionId: string, paneId: string): void;
  /** Retire a pane's picker focus. CLIENT-LOCAL, like `selectPane`. */
  dismissPicker(sessionId: string, paneId: string): void;
  /**
   * Point whichever pane is showing `oldConversationId` at its replacement.
   * Used when the current conversation is deleted and re-minted into the
   * SAME session (`AgentPageView`'s delete flow) — a no-op if the deleted
   * conversation was not showing in any pane.
   */
  replaceConversation(sessionId: string, oldConversationId: string, newScope: PaneScope): void;
  /**
   * Drop a session's grid entirely (the session was ended elsewhere). Also
   * abandons anything still queued for it — the rows are gone server-side, so
   * there is nothing left for those verbs to land on.
   */
  forgetWorkspace(sessionId: string): void;
  /**
   * Seat a grid LOCALLY, without claiming to know its rev — the sidebar's
   * server-listing snapshot for a session `AgentPanes` isn't rendering, and
   * the rollback path when ending a session fails. Unconditional and
   * last-write-wins over whatever the store held, and it CLEARS the unacked
   * queue (a rollback's whole point is that nothing local survives).
   *
   * Seating a snapshot at an unknown rev is now safe without any latch: the
   * first verb posted from it 409s once and rebases on the truth. That is
   * precisely the arbitration `adoptServerWorkspaceAsHydrated` used to do by
   * hand.
   */
  hydrateWorkspace(sessionId: string, workspace: WorkspaceState): void;
  /** Adopt a `{rev, grid}` snapshot straight from the server (the mount GET / a resync). */
  hydrateFromServer(sessionId: string, snapshot: WorkspaceLayoutSnapshot): void;
  /** Apply a `workspace:updated` broadcast. See the module doc for the three-way rule. */
  applyRemoteUpdate(payload: WorkspaceUpdatedEvent): void;
  /** Re-read the server's snapshot for a session (mount, socket reconnect, or a give-up). */
  refreshWorkspaceSnapshot(sessionId: string): Promise<void>;
}

/** The layout GET's body, and what a verb response carries back. */
export interface WorkspaceLayoutSnapshot {
  rev: number;
  grid: PersistedColumnState[] | null;
}

/** The `workspace:updated` payload, as it arrives on the `session:<id>` room. */
export interface WorkspaceUpdatedEvent {
  workspaceId: string;
  rev: number;
  /** The opId of the verb that caused it, when a verb caused it — how a client spots its own echo. */
  opId?: string | null;
  grid: PersistedColumnState[];
}

const gridSchema = z.array(persistedColumnStateSchema);

const snapshotSchema = z.object({
  rev: z.number().int().min(0),
  grid: gridSchema.nullable(),
});

const verbResponseSchema = z.object({
  rev: z.number().int().min(0),
  grid: gridSchema,
});

/**
 * Transport give-up threshold. A verb that cannot be settled after this many
 * consecutive failures (network down, a 5xx, or a workspace so contended that
 * every rebase 409s again) is ABANDONED and the server's snapshot re-read:
 * showing the user the durable truth beats showing them a local edit that
 * will silently evaporate on the next reload. The old debounced PUT dropped
 * such saves the same way, just without ever correcting the display.
 */
const MAX_TRANSPORT_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [300, 900, 2400, 5000];

/**
 * `crypto.randomUUID` where available, with a counter fallback so a
 * non-secure-context browser (or a test environment without it) still mints
 * distinct pane ids rather than colliding on one.
 */
let paneCounter = 0;
function mintId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  paneCounter += 1;
  return `${prefix}-${paneCounter}`;
}

function emptySync(): WorkspaceSync {
  return { base: null, rev: 0, pending: [], inFlight: null, attempts: 0 };
}

/**
 * Bumped whenever a session's queue is reset from outside it
 * (`forgetWorkspace`, `hydrateWorkspace`). A verb response that comes back
 * carrying an older generation is DROPPED rather than applied — otherwise a
 * slow POST could resurrect a grid the user just ended, or overwrite a
 * rollback with the state it rolled back from. Module-level, so it survives
 * the sync entry itself being deleted.
 */
const queueGeneration = new Map<string, number>();

function generationOf(sessionId: string): number {
  return queueGeneration.get(sessionId) ?? 0;
}

function bumpGeneration(sessionId: string): void {
  queueGeneration.set(sessionId, generationOf(sessionId) + 1);
}

/**
 * Test-only full reset. A real page load never needs it; tests, sharing one
 * module scope, do — and resetting `workspaces` ALONE is not enough and never
 * was safe: the rendered grid is derived from `sync`, so a leftover queue
 * would replay a previous test's verbs into the next one's fresh grid.
 */
export function __resetWorkspaceQueuesForTests(): void {
  queueGeneration.clear();
  registeredEditing.clear();
  for (const timeout of retryTimers.values()) clearTimeout(timeout);
  retryTimers.clear();
  useAgentWorkspaceStore.setState({ workspaces: {}, sync: {}, focus: {} });
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Sessions currently registered with `useEditingStore` — the repo's
 * refresh-protection rule, inherited from the debounced PUT's own
 * `performSave`. Registered while ANY verb is unacked (an auth refresh or an
 * SWR clobber mid-queue would be exactly the interruption the rule exists to
 * prevent), released the moment the queue drains. Tracked here rather than
 * called unconditionally so a drained queue does not re-enter the editing
 * store on every subsequent render.
 */
const registeredEditing = new Set<string>();

function syncEditingRegistration(sessionId: string, queued: boolean): void {
  const editingId = `workspace-verbs:${sessionId}`;
  if (queued && !registeredEditing.has(sessionId)) {
    registeredEditing.add(sessionId);
    useEditingStore.getState().startEditing(editingId, 'other', { componentName: `workspace-verbs:${sessionId}` });
    return;
  }
  if (!queued && registeredEditing.has(sessionId)) {
    registeredEditing.delete(sessionId);
    useEditingStore.getState().endEditing(editingId);
  }
}

/**
 * What focus should be after a commit.
 *  - `'follow-reducer'`: a local transition just ran and the reducer already
 *    decided where focus goes (a split focuses its new pane, an assign
 *    focuses what it bound) — take its word.
 *  - `'preserve'`: new SERVER truth arrived; keep the user's focus if the
 *    pane still exists, and fall back to the first pane only if it doesn't.
 *    A remote edit must never steal focus.
 *  - an explicit focus: the two client-local actions (`selectPane`,
 *    `dismissPicker`), which are nothing BUT a focus change.
 */
type FocusIntent = 'follow-reducer' | 'preserve' | WorkspaceFocus;

/**
 * THE single write. Recomputes the rendered state from `sync`, resolves focus
 * per `intent`, stores all three maps, keeps the editing registration honest,
 * and kicks the send pump.
 */
function commit(sessionId: string, sync: WorkspaceSync, intent: FocusIntent): void {
  const structural = replayPending(sync.base, sessionId, sync.pending);

  useAgentWorkspaceStore.setState((state) => {
    const workspaces = { ...state.workspaces };
    const focus = { ...state.focus };

    if (structural === null) {
      delete workspaces[sessionId];
      delete focus[sessionId];
    } else {
      const paneIds = new Set(panesOf(structural).map((pane) => pane.id));
      const desired =
        intent === 'follow-reducer'
          ? { activePaneId: structural.activePaneId, pendingPickerPaneId: structural.pendingPickerPaneId }
          : intent === 'preserve'
            ? (focus[sessionId] ?? null)
            : intent;
      // Neither the wire nor a saved blob cross-validates that `activePaneId`
      // names a pane inside `columns` — normalize HERE, at the one place any
      // grid enters the store, rather than leaving every consumer to grow its
      // own fallback.
      const fallbackPaneId = paneIds.has(structural.activePaneId)
        ? structural.activePaneId
        : panesOf(structural)[0].id;
      const activePaneId =
        desired && paneIds.has(desired.activePaneId) ? desired.activePaneId : fallbackPaneId;
      const pendingPickerPaneId =
        desired && desired.pendingPickerPaneId !== null && paneIds.has(desired.pendingPickerPaneId)
          ? desired.pendingPickerPaneId
          : null;
      workspaces[sessionId] = { ...structural, activePaneId, pendingPickerPaneId };
      focus[sessionId] = { activePaneId, pendingPickerPaneId };
    }

    return { workspaces, focus, sync: { ...state.sync, [sessionId]: sync } };
  });

  syncEditingRegistration(sessionId, sync.pending.length > 0);
  void pump(sessionId);
}

/** Drop every trace of a session — grid, focus, queue — and orphan anything in flight. */
function drop(sessionId: string): void {
  bumpGeneration(sessionId);
  const timer = retryTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(sessionId);
  }
  syncEditingRegistration(sessionId, false);
  useAgentWorkspaceStore.setState((state) => {
    const { [sessionId]: _grid, ...workspaces } = state.workspaces;
    const { [sessionId]: _focus, ...focus } = state.focus;
    const { [sessionId]: _sync, ...sync } = state.sync;
    return { workspaces, focus, sync };
  });
}

/**
 * Apply a verb locally through the shared reducer and enqueue it for the
 * server. A verb the reducer declines (a stale click racing a close, an
 * `ensure` on a grid that already exists) never reaches the queue: there is
 * nothing to converge on.
 */
function enqueueVerb(sessionId: string, verb: WorkspaceLayoutVerb): void {
  const state = useAgentWorkspaceStore.getState();
  const sync = state.sync[sessionId] ?? emptySync();
  const current = state.workspaces[sessionId] ?? null;
  if (!applyVerbLocal(current, sessionId, verb).applied) return;
  const op: PendingVerbOp = { opId: mintId('op'), baseRev: sync.rev, verb };
  commit(sessionId, { ...sync, pending: [...sync.pending, op] }, 'follow-reducer');
}

function workspaceUrl(sessionId: string): string {
  return `/api/agent-sessions/${encodeURIComponent(sessionId)}/workspace`;
}

/**
 * Send the head of a session's queue, one at a time. Serial by construction:
 * op N's `baseRev` is only knowable once op N-1 has been answered, which is
 * also why `baseRev` is re-stamped from the CURRENT snapshot here rather than
 * taken from the op's own record.
 */
async function pump(sessionId: string): Promise<void> {
  const sync = useAgentWorkspaceStore.getState().sync[sessionId];
  if (!sync || sync.inFlight !== null || sync.pending.length === 0) return;
  if (retryTimers.has(sessionId)) return;

  const op = sync.pending[0];
  const generation = generationOf(sessionId);
  commit(sessionId, { ...sync, inFlight: op.opId }, 'preserve');

  let response: Response | undefined;
  try {
    response = await fetchWithAuth(`${workspaceUrl(sessionId)}/verbs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opId: op.opId,
        baseRev: useAgentWorkspaceStore.getState().sync[sessionId]?.rev ?? op.baseRev,
        verb: op.verb,
      }),
    });
  } catch {
    // Transport failure — the op is unchanged and still ours to retry.
  }

  await settle(sessionId, op, generation, response);
}

/** Decide what one verb POST's answer means for the queue, then commit it. */
async function settle(
  sessionId: string,
  op: PendingVerbOp,
  generation: number,
  response: Response | undefined,
): Promise<void> {
  // EVERY await happens before the state read. Reading `sync` first and then
  // awaiting the body would drop any verb enqueued in that window — a real
  // and routine race (a mint's success callback assigns its pane the instant
  // its POST resolves, which is exactly when the previous verb's body is
  // being parsed), and the queue would silently lose the write.
  const body = response ? await response.json().catch(() => null) : null;

  if (generationOf(sessionId) !== generation) return;
  const sync = useAgentWorkspaceStore.getState().sync[sessionId];
  if (!sync || sync.inFlight !== op.opId) return;
  const rest = sync.pending.filter((queued) => queued.opId !== op.opId);

  // Transport failure, or a server that could not answer: retry the SAME op.
  if (!response || response.status >= 500) {
    scheduleRetry(sessionId, { ...sync, inFlight: null, attempts: sync.attempts + 1 });
    return;
  }

  if (response.status === 409) {
    const parsed = verbResponseSchema.safeParse(body);
    if (!parsed.success) {
      scheduleRetry(sessionId, { ...sync, inFlight: null, attempts: sync.attempts + 1 });
      return;
    }
    // The 409 body IS the truth. Rebase on it and re-post from the head
    // IMMEDIATELY — `op` did NOT land, and unlike a transport failure there
    // is nothing to wait for: the server just told us everything we were
    // missing. The attempt still counts, so a permanently contended
    // workspace cannot spin forever.
    retry(sessionId, {
      base: adoptServerGrid(sessionId, parsed.data.grid),
      rev: parsed.data.rev,
      pending: sync.pending,
      inFlight: null,
      attempts: sync.attempts + 1,
    });
    return;
  }

  if (!response.ok) {
    // A 4xx that is not a 409 (a rejected payload, a session that is gone or
    // no longer ours) will never succeed on retry. Abandon the queue and go
    // read what is actually durable.
    commit(sessionId, { ...sync, pending: [], inFlight: null, attempts: 0 }, 'preserve');
    void useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(sessionId);
    return;
  }

  const parsed = verbResponseSchema.safeParse(body);
  if (!parsed.success) {
    // Acked, but we learned no truth. Fold the op into the snapshot so the
    // rendered state is unchanged and the equation stays true.
    commit(
      sessionId,
      {
        ...sync,
        base: applyVerbLocal(sync.base, sessionId, op.verb).state,
        pending: rest,
        inFlight: null,
        attempts: 0,
      },
      'preserve',
    );
    return;
  }

  // 200 — adopt the returned truth even when `applied: false`: a no-op still
  // reports the current rev, and ignoring it would strand us behind forever.
  commit(
    sessionId,
    {
      base: adoptServerGrid(sessionId, parsed.data.grid),
      rev: parsed.data.rev,
      pending: rest,
      inFlight: null,
      attempts: 0,
    },
    'preserve',
  );
}

/**
 * Re-post the head op right away (the 409 path — the server just handed us
 * everything we were missing), or give up and resync once the attempt budget
 * is spent. `commit` kicks the pump, and nothing blocks it.
 */
function retry(sessionId: string, sync: WorkspaceSync): void {
  if (giveUp(sessionId, sync)) return;
  commit(sessionId, sync, 'preserve');
}

/**
 * Back off, then re-pump (the transport-failure path — there is nothing to
 * rebase on, only a network to wait for). The timer is registered BEFORE the
 * commit: `commit` kicks the pump, and the pump's `retryTimers` guard is the
 * only thing standing between a failed op and a backoff-free re-send loop.
 */
function scheduleRetry(sessionId: string, sync: WorkspaceSync): void {
  if (giveUp(sessionId, sync)) return;
  const delay = RETRY_BACKOFF_MS[Math.min(sync.attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? 0;
  const timer = setTimeout(() => {
    retryTimers.delete(sessionId);
    void pump(sessionId);
  }, delay);
  retryTimers.set(sessionId, timer);
  commit(sessionId, sync, 'preserve');
}

/** Spent the attempt budget: abandon the queue and go read what is durable. */
function giveUp(sessionId: string, sync: WorkspaceSync): boolean {
  if (sync.attempts < MAX_TRANSPORT_ATTEMPTS) return false;
  commit(sessionId, { ...sync, pending: [], attempts: 0 }, 'preserve');
  void useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(sessionId);
  return true;
}

/**
 * Is `pane` a PAGE pane whose target currently has unsaved edits? Checked
 * against `useEditingStore` by pageId (not by the pane's own id — the
 * editing-store componentId carries a per-mount `useId()` suffix the pane
 * model knows nothing about), so a dirty document/canvas/sheet page is never
 * silently overwritten by `focusOrAssignScope`'s replace path (only 'document'
 * and 'form' session types count as dirty for this purpose — see
 * `useEditingStore.isAnyEditing`'s identical set).
 *
 * The server's own reducer deliberately does NOT know this predicate — it
 * cannot; only a browser knows what is half-typed in it. That is why this
 * runs BEFORE a verb is minted, and why the store never emits the server's
 * `open_conversation` policy verb for a user-driven open.
 */
function isPaneDirty(pane: PaneState): boolean {
  if (pane.scope?.kind !== 'page' || pane.scope.targetId === null) return false;
  const targetPageId = pane.scope.targetId;
  return useEditingStore
    .getState()
    .getActiveSessions()
    .some((session) => (session.type === 'document' || session.type === 'form') && session.metadata?.pageId === targetPageId);
}

/**
 * Shared by `openConversation` and `openPage`: make `scope`'s target VISIBLE
 * in the session's grid, resolving the whole policy HERE (see the module doc)
 * and emitting only the primitive verb it resolved to.
 */
function focusOrAssignScope(
  sessionId: string,
  scope: PaneScope,
  options?: {
    excludeTargetId?: string;
    liveConversationIds?: ReadonlySet<string>;
    preferSplit?: boolean;
  },
): void {
  const store = useAgentWorkspaceStore.getState();
  const workspace = store.workspaces[sessionId];
  if (!workspace) {
    store.ensureWorkspace(sessionId, scope);
    return;
  }
  if (scope.targetId !== null) {
    const showing = paneShowing(workspace, scope.targetId);
    if (showing) {
      // Already visible — focus is client-local, so nothing crosses the wire.
      store.selectPane(sessionId, showing.id);
      return;
    }
  }
  const panes = panesOf(workspace);
  const active = panes.find((pane) => pane.id === workspace.activePaneId);
  // Replaceable = unbound (picker), or bound to a resolved, non-terminal
  // row. A pane whose mint is still in flight (`targetId === null`) is
  // EXCLUDED even though its kind isn't terminal: landing a different
  // selection there now means the mint's own success callback later
  // overwrites it with the stale pick. Also excluded: a pane with unsaved
  // edits (`isPaneDirty`), and — when the caller passed `excludeTargetId` —
  // the pane already showing THAT target (the `open_page_pane` tool's own
  // invoking conversation must never be evicted by its own tool call; it
  // should get a split beside it instead). Also excluded when the caller
  // passed `liveConversationIds` (only `openConversation` ever does, from
  // the selection/mount-seed paths): a BOUND pane whose scope is not a live
  // chat — a conversation closed out of this session (issue #2295), or a
  // PAGE pane, a deliberate persisted artifact a conversation selection has
  // no business evicting (a reload's seed effect used to eat agent-opened
  // page panes this way) — must never be silently overwritten by an
  // unrelated later selection; both fall through to the split fallback
  // instead, exactly like a terminal. And excluded wholesale under
  // `preferSplit` (the agent-driven `openPage` path): an agent adds a
  // surface, it never navigates the user's panes, so only an unbound picker
  // pane may be filled.
  const isReplaceable = (pane: PaneState) =>
    (pane.scope === null || (pane.scope.kind !== 'terminal' && pane.scope.targetId !== null)) &&
    !isPaneDirty(pane) &&
    (options?.excludeTargetId === undefined || pane.scope?.targetId !== options.excludeTargetId) &&
    (options?.preferSplit !== true || pane.scope === null) &&
    (options?.liveConversationIds === undefined ||
      pane.scope === null ||
      (pane.scope.kind === 'chat' &&
        (pane.scope.targetId === null || options.liveConversationIds.has(pane.scope.targetId))));
  const replaceable = active && isReplaceable(active) ? active : panes.find(isReplaceable);
  if (replaceable) {
    enqueueVerb(sessionId, { type: 'assign_pane', paneId: replaceable.id, scope });
    return;
  }
  // Nothing replaceable (every pane is a running terminal, dirty, or the
  // excluded invoker) — open beside them instead of losing anything. Two
  // verbs, in order: the split, then the binding.
  const newPaneId = mintId('pane');
  enqueueVerb(sessionId, {
    type: 'split_right',
    fromPaneId: workspace.activePaneId,
    newColumnId: mintId('col'),
    newPaneId,
  });
  enqueueVerb(sessionId, { type: 'assign_pane', paneId: newPaneId, scope });
}

export const useAgentWorkspaceStore = create<AgentWorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: {},
      sync: {},
      focus: {},

      ensureWorkspace: (sessionId, scope) =>
        enqueueVerb(sessionId, { type: 'ensure', columnId: mintId('col'), paneId: mintId('pane'), scope }),

      openConversation: (sessionId, scope, options) => focusOrAssignScope(sessionId, scope, options),

      openPage: (sessionId, scope, options) => focusOrAssignScope(sessionId, scope, options),

      splitRight: (sessionId, fromPaneId) =>
        enqueueVerb(sessionId, {
          type: 'split_right',
          fromPaneId,
          newColumnId: mintId('col'),
          newPaneId: mintId('pane'),
        }),

      splitDown: (sessionId, fromPaneId) =>
        enqueueVerb(sessionId, { type: 'split_down', fromPaneId, newPaneId: mintId('pane') }),

      closePane: (sessionId, paneId) => {
        const current = get().workspaces[sessionId];
        if (!current) return 'noop';
        if (!panesOf(current).some((pane) => pane.id === paneId)) return 'noop';
        if (isLastPane(current, paneId)) {
          // The LAST pane: emptying a session ends it, which is a lifecycle
          // act (the end route), never a layout verb — the shared reducer
          // no-ops on it by design, so no verb is posted here either. The
          // caller reads this verdict and ends the session.
          drop(sessionId);
          return 'session-ended';
        }
        enqueueVerb(sessionId, { type: 'close_pane', paneId });
        return 'closed';
      },

      selectPane: (sessionId, paneId) => {
        const state = get();
        const workspace = state.workspaces[sessionId];
        if (!workspace) return;
        if (workspace.activePaneId === paneId) return;
        if (!panesOf(workspace).some((pane) => pane.id === paneId)) return;
        commit(sessionId, state.sync[sessionId] ?? emptySync(), {
          activePaneId: paneId,
          pendingPickerPaneId: workspace.pendingPickerPaneId,
        });
      },

      assignPane: (sessionId, paneId, scope) => enqueueVerb(sessionId, { type: 'assign_pane', paneId, scope }),

      resetPane: (sessionId, paneId) => enqueueVerb(sessionId, { type: 'reset_pane', paneId }),

      dismissPicker: (sessionId, paneId) => {
        const state = get();
        const workspace = state.workspaces[sessionId];
        if (!workspace || workspace.pendingPickerPaneId !== paneId) return;
        commit(sessionId, state.sync[sessionId] ?? emptySync(), {
          activePaneId: workspace.activePaneId,
          pendingPickerPaneId: null,
        });
      },

      replaceConversation: (sessionId, oldConversationId, newScope) =>
        enqueueVerb(sessionId, {
          type: 'replace_conversation',
          oldTargetId: oldConversationId,
          scope: newScope,
        }),

      forgetWorkspace: (sessionId) => {
        if (!get().sync[sessionId] && !get().workspaces[sessionId]) return;
        drop(sessionId);
      },

      hydrateWorkspace: (sessionId, workspace) => {
        // `workspace.id` is documented as "the SESSION id whose grid this
        // is" — a mismatch means the caller fetched the wrong session's
        // saved grid (or the payload was tampered with); seating it under a
        // DIFFERENT session's key would poison every consumer that trusts
        // `workspace.id` to match.
        if (workspace.id !== sessionId) return;
        const previous = get().sync[sessionId];
        // A verb still on the wire belongs to the state being replaced.
        bumpGeneration(sessionId);
        commit(
          sessionId,
          { base: workspace, rev: previous?.rev ?? 0, pending: [], inFlight: null, attempts: 0 },
          // The snapshot carries its own focus (the blob still round-trips
          // it) — honor it, falling back to the first pane if it dangles.
          { activePaneId: workspace.activePaneId, pendingPickerPaneId: workspace.pendingPickerPaneId },
        );
      },

      hydrateFromServer: (sessionId, snapshot) => {
        const sync = get().sync[sessionId] ?? emptySync();
        // An older snapshot than what we already hold tells us nothing (a
        // slow GET landing behind a fast verb ack, say).
        if (snapshot.rev < sync.rev) return;
        commit(
          sessionId,
          { ...sync, base: adoptServerGrid(sessionId, snapshot.grid), rev: snapshot.rev },
          'preserve',
        );
      },

      applyRemoteUpdate: (payload) => {
        const sessionId = payload.workspaceId;
        const sync = get().sync[sessionId];
        // Not tracking this session: nothing to update, and inventing an
        // entry here would resurrect a grid the user has closed. Whenever it
        // opens next, the mount GET reads the truth anyway.
        if (!sync) return;
        // Already at or past this rev — including our OWN echo of a verb the
        // ack has already applied.
        if (payload.rev <= sync.rev) return;
        // Our own verb, still unanswered: the POST's own 200/409 is the
        // authoritative answer and is already on its way. Adopting the echo
        // here would replay the op on a snapshot that already contains it.
        if (
          payload.opId &&
          (sync.inFlight === payload.opId || sync.pending.some((op) => op.opId === payload.opId))
        ) {
          return;
        }
        commit(
          sessionId,
          { ...sync, base: adoptServerGrid(sessionId, payload.grid), rev: payload.rev },
          'preserve',
        );
      },

      refreshWorkspaceSnapshot: async (sessionId) => {
        try {
          const response = await fetchWithAuth(workspaceUrl(sessionId));
          if (!response.ok) return;
          const parsed = snapshotSchema.safeParse(await response.json());
          if (!parsed.success) return;
          get().hydrateFromServer(sessionId, parsed.data);
        } catch {
          // Best-effort: the socket's own reconnect, or the next mutation's
          // 409, will bring the truth along.
        }
      },
    }),
    {
      name: 'agent-workspace-storage',
      // v2 = the grid is no longer persisted. `partialize` alone would leave
      // a v1 payload's `workspaces` key sitting in storage, so the version
      // bump is what actually retires it.
      version: 2,
      partialize: (state) => ({ focus: state.focus }),
      merge: (persisted, current) => ({ ...current, focus: validatePersistedFocus(persisted) }),
    },
  ),
);

/**
 * `persist`'s `merge` hook. Storage is untyped by construction (a previous
 * schema version, an extension, plain corruption), and this is the one place
 * a foreign value could enter the store — so every entry is shape-checked and
 * anything that fails is dropped rather than repaired. A lost focus preference
 * costs the user nothing: the grid re-focuses its first pane.
 */
function validatePersistedFocus(persisted: unknown): Record<string, WorkspaceFocus> {
  const parsed = z
    .object({
      focus: z.record(
        z.string(),
        z.object({ activePaneId: z.string().min(1), pendingPickerPaneId: z.string().min(1).nullable() }),
      ),
    })
    .safeParse(persisted);
  return parsed.success ? parsed.data.focus : {};
}
