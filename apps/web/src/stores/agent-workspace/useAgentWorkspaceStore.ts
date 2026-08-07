import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import { type PaneScope, type PersistedColumnState } from '@pagespace/lib/agent-workspaces/contract';
import {
  workspaceLayoutSnapshotSchema,
  workspaceLayoutStaleResponseSchema,
  workspaceLayoutVerbResponseSchema,
  type WorkspaceLayoutSnapshot,
} from '@pagespace/lib/agent-workspaces/workspace-layout-wire';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import {
  applyVerbLocal,
  isLastPane,
  panesOf,
  type PaneState,
  type WorkspaceLayoutVerb,
  type WorkspaceState,
} from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import { resolveOpenPlacement } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import { adoptServerGrid, replayPending, type PendingVerbOp } from './verb-queue';
import { carryPaneLabelsForward, hasUnknownBoundTarget, paneLabelIndex } from './pane-labels';

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
 * **Broadcasts carry no labels** (security review HIGH 1). `session:<id>` is
 * a room, so one payload reaches every member of a shared workspace at once
 * and per-viewer title redaction is not expressible on it; the server ships
 * structure only. Names are this client's own business: known bindings keep
 * their label across a broadcast (`pane-labels.ts`), and a broadcast that
 * introduces a target we have never labelled triggers one
 * `refreshWorkspaceSnapshot` — the access-checked GET, whose labels are
 * resolved for THIS viewer and nobody else.
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

/**
 * Why a session's pending layout work was thrown away.
 *
 * The store's own reasoning is that showing the user the durable truth beats
 * showing them a local edit that will silently evaporate — but it never showed
 * them anything. Every abandon path (a 403 from the scope gate, a rejected
 * payload, a spent attempt budget) reset `pending` to `[]` and refetched, so
 * the split or resize the user just made vanished with no toast, no log, and no
 * flag anything could render. This is the flag; `AgentPanes` renders it.
 *
 *   refused       a 4xx that is not a 409 — the server will never accept this
 *                 verb. Most often the pane-scope gate saying the target is not
 *                 the caller's to show.
 *   abandoned     the transport failed MAX_TRANSPORT_ATTEMPTS times running.
 *   stale-display the abandon happened AND the resync that was supposed to
 *                 replace it also failed, so what is on screen is neither the
 *                 user's edit nor the server's truth.
 */
export interface WorkspaceQueueError {
  reason: 'refused' | 'abandoned' | 'stale-display';
  /** Set once per transition, so a renderer can fire a toast without repeating it. */
  at: number;
}

interface AgentWorkspaceState {
  /** workspaceId → what to render. Derived: `replayPending(base, pending)` plus the focus overlay. */
  workspaces: Record<string, WorkspaceState>;
  /** workspaceId → the server snapshot + unacked queue behind it. */
  sync: Record<string, WorkspaceSync>;
  /** workspaceId → client-local focus. The ONLY thing this store persists. */
  focus: Record<string, WorkspaceFocus>;
  /** workspaceId → why its queue was dropped, or null once anything settles cleanly. */
  queueErrors: Record<string, WorkspaceQueueError | null>;

  /** Give a session its opening grid, once. Idempotent. */
  ensureWorkspace(workspaceId: string, scope: PaneScope): void;
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
   * closed out of this session (`closedInWorkspaceAt`) — AND any page pane (a
   * deliberate, persisted artifact; a reload's seed effect used to silently
   * evict agent-opened pages this way) from an unrelated later selection
   * (issue #2295); both fall through to the split fallback instead, exactly
   * like a terminal/dirty pane does. Omitted (any caller that hasn't learned
   * the live set yet), behavior is unchanged — this guard is strictly
   * additive.
   */
  openConversation(
    workspaceId: string,
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
    workspaceId: string,
    scope: PaneScope,
    options?: { excludeTargetId?: string; preferSplit?: boolean },
  ): void;
  splitRight(workspaceId: string, fromPaneId: string): void;
  splitDown(workspaceId: string, fromPaneId: string): void;
  /**
   * Close a pane. Closing the LAST pane removes the whole grid and returns
   * `'session-ended'` — the caller owns the IO that ends the session; the
   * store owns only the layout fact.
   */
  closePane(workspaceId: string, paneId: string): 'closed' | 'session-ended' | 'noop';
  /** Focus a pane. CLIENT-LOCAL — focus is not a row, so no verb crosses the wire. */
  selectPane(workspaceId: string, paneId: string): void;
  assignPane(workspaceId: string, paneId: string, scope: PaneScope): void;
  /** Unbind a pane back to the picker — a failed mint, first-class rather than a sentinel scope. */
  resetPane(workspaceId: string, paneId: string): void;
  /** Retire a pane's picker focus. CLIENT-LOCAL, like `selectPane`. */
  dismissPicker(workspaceId: string, paneId: string): void;
  /**
   * Give a column `widthFraction` of the grid's width (issue #2208). Unlike
   * focus, sizing IS a row — it restores cross-device and an agent can set it
   * — so this posts a verb like every other structural mutation, and the
   * shared reducer owns the clamping and the sibling renormalization.
   */
  resizeColumn(workspaceId: string, columnId: string, widthFraction: number): void;
  /** Give a pane `heightFraction` of ITS COLUMN's height. Column-local; see {@link resizeColumn}. */
  resizePane(workspaceId: string, paneId: string, heightFraction: number): void;
  /** Relocate a pane to another column and/or index. `toIndex` omitted = append. */
  movePane(workspaceId: string, paneId: string, toColumnId: string, toIndex?: number): void;
  /** Reorder the grid's columns. The list is read as a PREFIX — see the reducer's `reorderColumns`. */
  reorderColumns(workspaceId: string, columnIds: string[]): void;
  /**
   * Point whichever pane is showing `oldConversationId` at its replacement.
   * Used when the current conversation is deleted and re-minted into the
   * SAME session (`AgentPageView`'s delete flow) — a no-op if the deleted
   * conversation was not showing in any pane.
   */
  replaceConversation(workspaceId: string, oldConversationId: string, newScope: PaneScope): void;
  /**
   * Drop a session's grid entirely (the session was ended elsewhere). Also
   * abandons anything still queued for it — the rows are gone server-side, so
   * there is nothing left for those verbs to land on.
   */
  forgetWorkspace(workspaceId: string): void;
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
  hydrateWorkspace(workspaceId: string, workspace: WorkspaceState): void;
  /** Adopt a `{rev, grid}` snapshot straight from the server (the mount GET / a resync). */
  hydrateFromServer(workspaceId: string, snapshot: WorkspaceLayoutSnapshot): void;
  /** Apply a `workspace:updated` broadcast. See the module doc for the three-way rule. */
  applyRemoteUpdate(payload: WorkspaceUpdatedEvent): void;
  /** Re-read the server's snapshot for a session (mount, socket reconnect, or a give-up). */
  /** Re-read the access-checked snapshot. Resolves false when it could not be read. */
  refreshWorkspaceSnapshot(workspaceId: string): Promise<boolean>;
}

/** The `workspace:updated` payload, as it arrives on the `session:<id>` room. */
export interface WorkspaceUpdatedEvent {
  workspaceId: string;
  rev: number;
  /** The opId of the verb that caused it, when a verb caused it — how a client spots its own echo. */
  opId?: string | null;
  grid: PersistedColumnState[];
}

// The 409 body carries no `applied` — nothing was applied — so the two are
// parsed with different schemas rather than one loose shape.
const snapshotSchema = workspaceLayoutSnapshotSchema;
const verbResponseSchema = workspaceLayoutVerbResponseSchema;
const staleResponseSchema = workspaceLayoutStaleResponseSchema;

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
 * A NEW value on every page load, mixed into the counter fallback below.
 *
 * Without it the fallback restarted at 1 on every load, and both id families it
 * mints are compound-PK'd per workspace — so a reload re-minting `col-1` into
 * the same workspace wrote a duplicate id (the 500-then-discard path
 * `verb-queue.ts` documents), and a re-minted `op-1` was worse: the ops table
 * is PK'd `(workspaceId, opId)`, so `findOp` read it as a REPLAY, returned the
 * recorded rev and never applied the verb. No error, no retry, no toast — the
 * user's split or resize simply did not happen (review finding).
 *
 * Not hypothetical: the fallback is taken whenever `crypto.randomUUID` is
 * missing, which means any non-secure context — for this product, an
 * onprem/self-hosted deployment reached over plain HTTP on a LAN address.
 * `Math.random` needs no secure context, so the degraded path now degrades to
 * ugly ids rather than to ids that collide with the previous load's.
 */
const FALLBACK_MINT_NONCE = Math.random().toString(36).slice(2, 10);

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
  return `${prefix}-${FALLBACK_MINT_NONCE}-${paneCounter}`;
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
 *
 * ENTRIES ARE DELIBERATELY NEVER REMOVED, which is why `drop` bumps rather
 * than deletes (review finding — the Map grows for the lifetime of the tab).
 * Deleting would reset the counter to 0, and a response still in flight from
 * before the drop — minted at generation 0, because this workspace had never
 * been reset — would then MATCH the re-hydrated entry's fresh 0 and be
 * applied: precisely the resurrection the generation exists to prevent. The
 * cost of keeping them is one integer per workspace id the tab has ever
 * opened; the cost of dropping them is the bug. Giving the queue a
 * per-workspace controller created and disposed with the sync entry would
 * retire both, and is the shape to reach for if this ever needs to change.
 */
const queueGeneration = new Map<string, number>();

function generationOf(workspaceId: string): number {
  return queueGeneration.get(workspaceId) ?? 0;
}

function bumpGeneration(workspaceId: string): void {
  queueGeneration.set(workspaceId, generationOf(workspaceId) + 1);
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
  for (const timeout of labelRefreshTimers.values()) clearTimeout(timeout);
  labelRefreshTimers.clear();
  useAgentWorkspaceStore.setState({ workspaces: {}, sync: {}, focus: {}, queueErrors: {} });
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Trailing debounce for the label-resolving refetch.
 *
 * A broadcast that introduces a target this client has never labelled is the
 * one case it cannot dress itself, so it goes and reads the access-checked GET.
 * Un-debounced, an agent placing three panes meant three broadcasts and three
 * GETs — and the last one's answer is the only one that could have been
 * complete anyway.
 */
const LABEL_REFRESH_DEBOUNCE_MS = 150;
const labelRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleLabelRefresh(workspaceId: string): void {
  const existing = labelRefreshTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  labelRefreshTimers.set(
    workspaceId,
    setTimeout(() => {
      labelRefreshTimers.delete(workspaceId);
      void useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(workspaceId);
    }, LABEL_REFRESH_DEBOUNCE_MS),
  );
}

function cancelLabelRefresh(workspaceId: string): void {
  const timer = labelRefreshTimers.get(workspaceId);
  if (timer) {
    clearTimeout(timer);
    labelRefreshTimers.delete(workspaceId);
  }
}

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

function syncEditingRegistration(workspaceId: string, queued: boolean): void {
  const editingId = `workspace-verbs:${workspaceId}`;
  if (queued && !registeredEditing.has(workspaceId)) {
    registeredEditing.add(workspaceId);
    useEditingStore.getState().startEditing(editingId, 'other', { componentName: `workspace-verbs:${workspaceId}` });
    return;
  }
  if (!queued && registeredEditing.has(workspaceId)) {
    registeredEditing.delete(workspaceId);
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
function commit(workspaceId: string, sync: WorkspaceSync, intent: FocusIntent): void {
  const structural = replayPending(sync.base, workspaceId, sync.pending);

  useAgentWorkspaceStore.setState((state) => {
    const workspaces = { ...state.workspaces };
    const focus = { ...state.focus };

    if (structural === null) {
      delete workspaces[workspaceId];
      delete focus[workspaceId];
    } else {
      const paneIds = new Set(panesOf(structural).map((pane) => pane.id));
      const desired =
        intent === 'follow-reducer'
          ? { activePaneId: structural.activePaneId, pendingPickerPaneId: structural.pendingPickerPaneId }
          : intent === 'preserve'
            ? (focus[workspaceId] ?? null)
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
      workspaces[workspaceId] = { ...structural, activePaneId, pendingPickerPaneId };
      focus[workspaceId] = { activePaneId, pendingPickerPaneId };
    }

    return { workspaces, focus, sync: { ...state.sync, [workspaceId]: sync } };
  });

  syncEditingRegistration(workspaceId, sync.pending.length > 0);
  void pump(workspaceId);
}

/** Drop every trace of a session — grid, focus, queue — and orphan anything in flight. */
function drop(workspaceId: string): void {
  bumpGeneration(workspaceId);
  const timer = retryTimers.get(workspaceId);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(workspaceId);
  }
  cancelLabelRefresh(workspaceId);
  syncEditingRegistration(workspaceId, false);
  useAgentWorkspaceStore.setState((state) => {
    const { [workspaceId]: _grid, ...workspaces } = state.workspaces;
    const { [workspaceId]: _focus, ...focus } = state.focus;
    const { [workspaceId]: _sync, ...sync } = state.sync;
    const { [workspaceId]: _err, ...queueErrors } = state.queueErrors;
    return { workspaces, focus, sync, queueErrors };
  });
}

/**
 * Apply a verb locally through the shared reducer and enqueue it for the
 * server. A verb the reducer declines (a stale click racing a close, an
 * `ensure` on a grid that already exists) never reaches the queue: there is
 * nothing to converge on.
 */
function enqueueVerb(workspaceId: string, verb: WorkspaceLayoutVerb): void {
  const state = useAgentWorkspaceStore.getState();
  const sync = state.sync[workspaceId] ?? emptySync();
  const current = state.workspaces[workspaceId] ?? null;
  if (!applyVerbLocal(current, workspaceId, verb).applied) return;
  const op: PendingVerbOp = { opId: mintId('op'), baseRev: sync.rev, verb };
  commit(workspaceId, { ...sync, pending: [...sync.pending, op] }, 'follow-reducer');
}

function workspaceUrl(workspaceId: string): string {
  return `/api/agent-workspaces/${encodeURIComponent(workspaceId)}/workspace`;
}

/**
 * Send the head of a session's queue, one at a time. Serial by construction:
 * op N's `baseRev` is only knowable once op N-1 has been answered, which is
 * also why `baseRev` is re-stamped from the CURRENT snapshot here rather than
 * taken from the op's own record.
 */
async function pump(workspaceId: string): Promise<void> {
  const sync = useAgentWorkspaceStore.getState().sync[workspaceId];
  if (!sync || sync.inFlight !== null || sync.pending.length === 0) return;
  if (retryTimers.has(workspaceId)) return;

  const op = sync.pending[0];
  const generation = generationOf(workspaceId);
  commit(workspaceId, { ...sync, inFlight: op.opId }, 'preserve');

  let response: Response | undefined;
  try {
    response = await fetchWithAuth(`${workspaceUrl(workspaceId)}/verbs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opId: op.opId,
        baseRev: useAgentWorkspaceStore.getState().sync[workspaceId]?.rev ?? op.baseRev,
        verb: op.verb,
      }),
    });
  } catch {
    // Transport failure — the op is unchanged and still ours to retry.
  }

  await settle(workspaceId, op, generation, response);
}

/** Decide what one verb POST's answer means for the queue, then commit it. */
async function settle(
  workspaceId: string,
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

  if (generationOf(workspaceId) !== generation) return;
  const sync = useAgentWorkspaceStore.getState().sync[workspaceId];
  if (!sync || sync.inFlight !== op.opId) return;
  const rest = sync.pending.filter((queued) => queued.opId !== op.opId);

  // Transport failure, or a server that could not answer: retry the SAME op.
  if (!response || response.status >= 500) {
    scheduleRetry(workspaceId, { ...sync, inFlight: null, attempts: sync.attempts + 1 });
    return;
  }

  if (response.status === 409) {
    // The STALE schema, not the 200 one: a 409 carries no `applied`, because
    // nothing was applied. Parsing it with the verb-response shape would fail
    // on the missing field and turn every rebase into a backoff-and-retry.
    const parsed = staleResponseSchema.safeParse(body);
    if (!parsed.success) {
      scheduleRetry(workspaceId, { ...sync, inFlight: null, attempts: sync.attempts + 1 });
      return;
    }
    // The 409 body IS the truth. Rebase on it and re-post from the head
    // IMMEDIATELY — `op` did NOT land, and unlike a transport failure there
    // is nothing to wait for: the server just told us everything we were
    // missing. The attempt still counts, so a permanently contended
    // workspace cannot spin forever.
    retry(workspaceId, {
      base: adoptServerGrid(workspaceId, parsed.data.grid),
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
    // read what is actually durable — and SAY SO: the user's split or resize is
    // being discarded, and silently reverting it reads as the app ignoring them.
    commit(workspaceId, { ...sync, pending: [], inFlight: null, attempts: 0 }, 'preserve');
    setQueueError(workspaceId, 'refused');
    void resyncAfterAbandon(workspaceId);
    return;
  }

  const parsed = verbResponseSchema.safeParse(body);
  if (!parsed.success) {
    // Acked, but we learned no truth. Fold the op into the snapshot so the
    // rendered state is unchanged and the equation stays true.
    commit(
      workspaceId,
      {
        ...sync,
        base: applyVerbLocal(sync.base, workspaceId, op.verb).state,
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
    workspaceId,
    {
      base: adoptServerGrid(workspaceId, parsed.data.grid),
      rev: parsed.data.rev,
      pending: rest,
      inFlight: null,
      attempts: 0,
    },
    'preserve',
  );
  // The queue is moving again, so whatever went wrong before is over.
  clearQueueError(workspaceId);
}

/** Forget a session's queue error — anything settling cleanly supersedes it. */
function clearQueueError(workspaceId: string): void {
  if (!useAgentWorkspaceStore.getState().queueErrors[workspaceId]) return;
  useAgentWorkspaceStore.setState((state) => ({
    queueErrors: { ...state.queueErrors, [workspaceId]: null },
  }));
}

/**
 * Re-post the head op right away (the 409 path — the server just handed us
 * everything we were missing), or give up and resync once the attempt budget
 * is spent. `commit` kicks the pump, and nothing blocks it.
 */
function retry(workspaceId: string, sync: WorkspaceSync): void {
  if (giveUp(workspaceId, sync)) return;
  commit(workspaceId, sync, 'preserve');
}

/**
 * Back off, then re-pump (the transport-failure path — there is nothing to
 * rebase on, only a network to wait for). The timer is registered BEFORE the
 * commit: `commit` kicks the pump, and the pump's `retryTimers` guard is the
 * only thing standing between a failed op and a backoff-free re-send loop.
 */
function scheduleRetry(workspaceId: string, sync: WorkspaceSync): void {
  if (giveUp(workspaceId, sync)) return;
  const delay = RETRY_BACKOFF_MS[Math.min(sync.attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? 0;
  const timer = setTimeout(() => {
    retryTimers.delete(workspaceId);
    void pump(workspaceId);
  }, delay);
  retryTimers.set(workspaceId, timer);
  commit(workspaceId, sync, 'preserve');
}

/** Spent the attempt budget: abandon the queue and go read what is durable. */
function giveUp(workspaceId: string, sync: WorkspaceSync): boolean {
  if (sync.attempts < MAX_TRANSPORT_ATTEMPTS) return false;
  commit(workspaceId, { ...sync, pending: [], attempts: 0 }, 'preserve');
  setQueueError(workspaceId, 'abandoned');
  void resyncAfterAbandon(workspaceId);
  return true;
}

/** Record why a session's queue was dropped. `at` makes each transition distinct. */
function setQueueError(workspaceId: string, reason: WorkspaceQueueError['reason']): void {
  useAgentWorkspaceStore.setState((state) => ({
    queueErrors: { ...state.queueErrors, [workspaceId]: { reason, at: Date.now() } },
  }));
}

/**
 * Refetch after abandoning the queue, and escalate if that fails too.
 *
 * Abandoning is only defensible because the refetch replaces the discarded work
 * with the server's truth. When the refetch ALSO fails, the rendered grid is
 * neither — it is whatever `base` happened to be, indefinitely, with nothing
 * saying so. That case used to disappear into `refreshWorkspaceSnapshot`'s
 * best-effort `catch {}`.
 */
async function resyncAfterAbandon(workspaceId: string): Promise<void> {
  const ok = await useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(workspaceId);
  if (!ok) setQueueError(workspaceId, 'stale-display');
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
  workspaceId: string,
  scope: PaneScope,
  options?: {
    excludeTargetId?: string;
    liveConversationIds?: ReadonlySet<string>;
    preferSplit?: boolean;
  },
): void {
  const store = useAgentWorkspaceStore.getState();
  const workspace = store.workspaces[workspaceId];
  if (!workspace) {
    store.ensureWorkspace(workspaceId, scope);
    return;
  }

  // The structural policy — the replaceable predicate, the `preferSplit` and
  // `excludeTargetId` narrowings, active-pane-first, and the split fallback —
  // is the SHARED one the server's `open_conversation` runs. What this store
  // adds are the two refusals the server cannot evaluate, injected on top:
  //
  //  - a pane with unsaved edits (`isPaneDirty`, via `useEditingStore`);
  //  - when the caller passed `liveConversationIds` (only `openConversation`
  //    does, from the selection/mount-seed paths): a BOUND pane whose scope is
  //    not a live chat — a conversation closed out of this session (issue
  //    #2295), or a PAGE pane, a deliberate persisted artifact a conversation
  //    selection has no business evicting (a reload's seed effect used to eat
  //    agent-opened page panes this way). Both fall through to the split
  //    fallback instead, exactly like a terminal.
  //
  // Those refusals are precisely why this store resolves the policy locally
  // and posts the RESULT (`assign_pane`, or `split_right` + `assign_pane`)
  // rather than sending the server's `open_conversation` verb.
  const placement = resolveOpenPlacement(workspace, scope.targetId, {
    preferSplit: options?.preferSplit,
    excludeTargetId: options?.excludeTargetId,
    isReplaceable: (pane) =>
      !isPaneDirty(pane) &&
      (options?.liveConversationIds === undefined ||
        pane.scope === null ||
        (pane.scope.kind === 'chat' &&
          (pane.scope.targetId === null || options.liveConversationIds.has(pane.scope.targetId)))),
  });

  switch (placement.kind) {
    case 'focus':
      // Already visible — focus is client-local, so nothing crosses the wire.
      store.selectPane(workspaceId, placement.paneId);
      return;
    case 'assign':
      enqueueVerb(workspaceId, { type: 'assign_pane', paneId: placement.paneId, scope });
      return;
    case 'split': {
      // Two verbs, in order: the split, then the binding.
      const newPaneId = mintId('pane');
      enqueueVerb(workspaceId, {
        type: 'split_right',
        fromPaneId: placement.fromPaneId,
        newColumnId: mintId('col'),
        newPaneId,
      });
      enqueueVerb(workspaceId, { type: 'assign_pane', paneId: newPaneId, scope });
      return;
    }
    case 'create':
      // Unreachable: the `!workspace` case returned above.
      return;
  }
}

export const useAgentWorkspaceStore = create<AgentWorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: {},
      sync: {},
      focus: {},
      queueErrors: {},

      ensureWorkspace: (workspaceId, scope) =>
        enqueueVerb(workspaceId, { type: 'ensure', columnId: mintId('col'), paneId: mintId('pane'), scope }),

      openConversation: (workspaceId, scope, options) => focusOrAssignScope(workspaceId, scope, options),

      openPage: (workspaceId, scope, options) => focusOrAssignScope(workspaceId, scope, options),

      splitRight: (workspaceId, fromPaneId) =>
        enqueueVerb(workspaceId, {
          type: 'split_right',
          fromPaneId,
          newColumnId: mintId('col'),
          newPaneId: mintId('pane'),
        }),

      splitDown: (workspaceId, fromPaneId) =>
        enqueueVerb(workspaceId, { type: 'split_down', fromPaneId, newPaneId: mintId('pane') }),

      closePane: (workspaceId, paneId) => {
        const current = get().workspaces[workspaceId];
        if (!current) return 'noop';
        if (!panesOf(current).some((pane) => pane.id === paneId)) return 'noop';
        if (isLastPane(current, paneId)) {
          // The LAST pane: emptying a session ends it, which is a lifecycle
          // act (the end route), never a layout verb — the shared reducer
          // no-ops on it by design, so no verb is posted here either. The
          // caller reads this verdict and ends the session.
          drop(workspaceId);
          return 'session-ended';
        }
        enqueueVerb(workspaceId, { type: 'close_pane', paneId });
        return 'closed';
      },

      selectPane: (workspaceId, paneId) => {
        const state = get();
        const workspace = state.workspaces[workspaceId];
        if (!workspace) return;
        if (workspace.activePaneId === paneId) return;
        if (!panesOf(workspace).some((pane) => pane.id === paneId)) return;
        commit(workspaceId, state.sync[workspaceId] ?? emptySync(), {
          activePaneId: paneId,
          pendingPickerPaneId: workspace.pendingPickerPaneId,
        });
      },

      assignPane: (workspaceId, paneId, scope) => enqueueVerb(workspaceId, { type: 'assign_pane', paneId, scope }),

      resetPane: (workspaceId, paneId) => enqueueVerb(workspaceId, { type: 'reset_pane', paneId }),

      dismissPicker: (workspaceId, paneId) => {
        const state = get();
        const workspace = state.workspaces[workspaceId];
        if (!workspace || workspace.pendingPickerPaneId !== paneId) return;
        commit(workspaceId, state.sync[workspaceId] ?? emptySync(), {
          activePaneId: workspace.activePaneId,
          pendingPickerPaneId: null,
        });
      },

      // The four rearrange verbs (issue #2208). Each is a plain enqueue: the
      // shared reducer applies it optimistically, decides whether it changed
      // anything at all (a clamped-to-identical resize never reaches the
      // queue), and the same 409-rebase path covers them as every other verb.
      resizeColumn: (workspaceId, columnId, widthFraction) =>
        enqueueVerb(workspaceId, { type: 'resize_column', columnId, widthFraction }),

      resizePane: (workspaceId, paneId, heightFraction) =>
        enqueueVerb(workspaceId, { type: 'resize_pane', paneId, heightFraction }),

      movePane: (workspaceId, paneId, toColumnId, toIndex) =>
        enqueueVerb(workspaceId, { type: 'move_pane', paneId, toColumnId, ...(toIndex === undefined ? {} : { toIndex }) }),

      reorderColumns: (workspaceId, columnIds) =>
        enqueueVerb(workspaceId, { type: 'reorder_columns', columnIds }),

      replaceConversation: (workspaceId, oldConversationId, newScope) =>
        enqueueVerb(workspaceId, {
          type: 'replace_conversation',
          oldTargetId: oldConversationId,
          scope: newScope,
        }),

      forgetWorkspace: (workspaceId) => {
        if (!get().sync[workspaceId] && !get().workspaces[workspaceId]) return;
        drop(workspaceId);
      },

      hydrateWorkspace: (workspaceId, workspace) => {
        // `workspace.id` is documented as "the SESSION id whose grid this
        // is" — a mismatch means the caller fetched the wrong session's
        // saved grid (or the payload was tampered with); seating it under a
        // DIFFERENT session's key would poison every consumer that trusts
        // `workspace.id` to match.
        if (workspace.id !== workspaceId) return;
        // A verb still on the wire belongs to the state being replaced.
        bumpGeneration(workspaceId);
        commit(
          workspaceId,
          // `rev: 0`, NOT the previous rev. This seats an UNVERSIONED listing
          // snapshot as the base, so carrying the old rev forward would claim
          // to have read this grid at a rev it was never read at — the method's
          // own doc says it does not know the rev. Both callers happen to be
          // safe (one guards on absence, the other restores after a failed
          // end-session), but `0` closes the class instead of relying on that;
          // the cost is one extra 409 on the rollback path.
          { base: workspace, rev: 0, pending: [], inFlight: null, attempts: 0 },
          // The snapshot carries its own focus — honor it, falling back to the
          // first pane if it dangles.
          { activePaneId: workspace.activePaneId, pendingPickerPaneId: workspace.pendingPickerPaneId },
        );
      },

      hydrateFromServer: (workspaceId, snapshot) => {
        const sync = get().sync[workspaceId] ?? emptySync();
        // An older snapshot than what we already hold tells us nothing (a
        // slow GET landing behind a fast verb ack, say).
        if (snapshot.rev < sync.rev) return;
        commit(
          workspaceId,
          { ...sync, base: adoptServerGrid(workspaceId, snapshot.grid), rev: snapshot.rev },
          'preserve',
        );
      },

      applyRemoteUpdate: (payload) => {
        const { workspaceId } = payload;
        const sync = get().sync[workspaceId];
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
        // The broadcast is label-free, so re-dress it from what this client
        // already knows before it reaches the renderer — otherwise a pure
        // resize would blank every pane header it touched.
        const known = paneLabelIndex(sync.base);
        const server = adoptServerGrid(workspaceId, payload.grid);
        // An emptied grid has no labels to carry and nothing to go read.
        const adopted = server === null ? null : carryPaneLabelsForward(known, server);
        commit(workspaceId, { ...sync, base: adopted, rev: payload.rev }, 'preserve');
        // A target we have never labelled is the ONE case a broadcast cannot
        // dress itself: go read it under this viewer's own authority.
        if (adopted !== null && hasUnknownBoundTarget(known, adopted)) {
          scheduleLabelRefresh(workspaceId);
        }
      },

      refreshWorkspaceSnapshot: async (workspaceId) => {
        try {
          const response = await fetchWithAuth(workspaceUrl(workspaceId));
          if (!response.ok) return false;
          const parsed = snapshotSchema.safeParse(await response.json());
          if (!parsed.success) return false;
          get().hydrateFromServer(workspaceId, parsed.data);
          return true;
        } catch {
          // Still best-effort for its own sake — the socket's own reconnect, or
          // the next mutation's 409, will bring the truth along. But the caller
          // now learns it failed, because a refetch that was covering for a
          // DISCARDED queue leaves the user looking at neither their edit nor
          // the server's state, and that is worth saying out loud.
          return false;
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
