/**
 * Agent workspace layout — production wiring (epic Phase 3, the #2202
 * machine-panes pattern re-cut for sessions).
 *
 * `applyWorkspaceLayoutVerb` is the SINGLE write path for every pane-grid
 * mutation arriving as a verb: it holds the per-workspace advisory lock
 * (`withWorkspaceLayoutLock`) for the ENTIRE read-reduce-write cycle, runs
 * the shared pure reducer (`applyVerbLocal`,
 * `@pagespace/lib/agent-workspaces/workspace-layout-verbs` — the SAME function
 * the client's optimistic apply uses), and persists through the store's one
 * write primitive, whose content diff is the AUTHORITATIVE "did anything
 * actually change" signal (it decides rev bumps and broadcasts; the
 * reducer's structural `applied` flag only knows whether the target
 * resolved).
 *
 * **Rows are the only source.** `agent_workspaces.workspaceState` (the legacy
 * jsonb blob) was dropped at Phase 3's contract step, along with its PUT and
 * the blob→rows reconcile — there is nothing left to dual-write and nothing
 * left to drift. Everything the rows deliberately do NOT own is derived
 * here, on the way out: pane LABELS by joining the conversation/shell/page
 * title at read time (`labelGrid`), and focus not at all (it is client-local
 * per #2048).
 *
 * **Idempotency.** Every verb POST carries a client-minted `opId`; a replay
 * (client timeout, duplicate delivery) finds its `(workspaceId, opId)`
 * memory row and short-circuits to the CURRENT truth instead of re-applying
 * — which matters because a replayed `split_right` would re-insert its
 * already-inserted client-minted pane id and violate the compound PK.
 *
 * **Concurrency.** A stale `baseRev` answers `status: 'stale'` with the
 * current rev + grid — truth to rebase against (the route maps it to 409).
 *
 * **Access control is split, deliberately.** Reaching a workspace at all is
 * NOT this module's job — the verbs route runs `checkSessionAccess` first,
 * same as every other session-scoped route, and binding a pane to a target
 * is gated there too (`authorize-pane-scope.ts`). But the LABEL join is this
 * module's job and always was a permission decision: a pane's `targetId` is
 * whatever the verb that bound it supplied, so every read path names the
 * viewer it is resolving for and every kind has its own gate
 * (`resolvePaneLabels`). The `session:<id>` broadcast has no single viewer
 * and therefore carries no labels at all.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { agentWorkspaceNodes } from '@pagespace/db/schema/agent-workspace-nodes';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaceShells, agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { pages } from '@pagespace/db/schema/core';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';
import { redactConversationTitleForViewer } from '@pagespace/lib/agent-workspaces/redact-conversation-listing';
import {
  applyVerbLocal,
  gridFromWorkspaceState,
  readFraction,
  workspaceStateFromGrid,
  type LayoutGridColumn,
  type WorkspaceLayoutGridDTO,
  type WorkspaceLayoutVerb,
} from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import {
  createDbWorkspaceLayoutStore,
  withWorkspaceLayoutLock,
} from '@pagespace/lib/services/agent-workspaces/workspace-layout-store';
import type { PaneScope, PersistedWorkspaceState } from '@pagespace/lib/agent-workspaces/contract';
import { broadcastWorkspaceUpdated } from '@/lib/websocket/agent-workspace-events';
import { conversationPageId } from '@pagespace/lib/conversations/conversation-page';

export type ApplyWorkspaceLayoutVerbResult =
  /** The op ran (or replayed, or no-oped). `applied` = the content diff's verdict. */
  | { status: 'ok'; rev: number; grid: WorkspaceLayoutGridDTO; applied: boolean }
  /** `baseRev` no longer names the current rev — here is the truth to rebase against. */
  | { status: 'stale'; rev: number; grid: WorkspaceLayoutGridDTO };

/** What the critical section decides, before labels are joined on the way out. */
type VerbOutcomeRows =
  | { status: 'ok'; rev: number; rows: LayoutGridColumn[]; applied: boolean }
  | { status: 'stale'; rev: number; rows: LayoutGridColumn[] };

export async function applyWorkspaceLayoutVerb(input: {
  workspaceId: string;
  opId: string;
  baseRev: number;
  verb: WorkspaceLayoutVerb;
  /**
   * Who the RESPONSE grid is labelled for. `null` labels nothing — correct
   * for the server-side placement helpers, which discard the grid entirely.
   * The broadcast never uses this: it has many viewers and gets its own
   * label-free grid (see below).
   */
  viewerId: LabelViewerId;
}): Promise<ApplyWorkspaceLayoutVerbResult> {
  const { workspaceId, opId, baseRev, verb, viewerId } = input;

  const outcome = await withWorkspaceLayoutLock(workspaceId, async (tx): Promise<VerbOutcomeRows> => {
    const store = await createDbWorkspaceLayoutStore(tx);

    const [grid, rev] = await Promise.all([store.getWorkspaceGrid(workspaceId), store.currentRev(workspaceId)]);
    const state = workspaceStateFromGrid({ workspaceId, grid });

    // Replay check FIRST: an op that already landed must answer success (with
    // current truth), never 409 — the retry's whole point is that its effect
    // is already part of the rev the client will observe.
    const replayed = await store.findOp(workspaceId, opId);
    if (replayed) {
      return { status: 'ok', rev, rows: grid, applied: false };
    }

    if (baseRev !== rev) {
      return { status: 'stale', rev, rows: grid };
    }

    const reduced = applyVerbLocal(state, workspaceId, verb);
    if (!reduced.applied || reduced.state === null) {
      await store.recordOp({ workspaceId, opId, rev, applied: false });
      return { status: 'ok', rev, rows: grid, applied: false };
    }

    const next = gridFromWorkspaceState(reduced.state);
    const written = await store.replaceWorkspaceGrid({ workspaceId, grid: next });
    await store.recordOp({ workspaceId, opId, rev: written.rev, applied: written.applied });
    return { status: 'ok', rev: written.rev, rows: next, applied: written.applied };
  });

  // Labels join OUTSIDE the lock: they are derived display data, so a racing
  // rename just means this response carries the title from a moment ago —
  // never a reason to hold the per-workspace serializing lock over more IO.
  //
  // The response is labelled for the ONE caller who will read it; the 409
  // stale body takes the same path, because "here is the truth to rebase
  // against" is still an answer to that caller and must not say more than a
  // GET would.
  const grid = await labelGrid(workspaceId, outcome.rows, viewerId);

  if (outcome.status === 'stale') return { status: 'stale', rev: outcome.rev, grid };

  if (outcome.applied) {
    // THE BROADCAST IS LABEL-FREE (security review HIGH 1). `session:<id>` is
    // a room: one payload reaches every member of a shared workspace at once,
    // so there is no viewer to redact for and per-viewer redaction is not
    // expressible on this wire. Shipping the structural grid — pane ids,
    // kinds, targetIds, size shares, and the rev — keeps the live-apply that
    // makes the layout feel shared (every geometry verb, which is most of
    // them, lands with no refetch at all) while disclosing nothing a member
    // could not already enumerate. Clients resolve names through their OWN
    // authorized reads: the store carries labels forward for panes it already
    // knows and calls `refreshWorkspaceSnapshot` — the access-checked
    // `GET /workspace` — when a broadcast introduces a target it cannot name.
    broadcastWorkspaceUpdated({
      workspaceId,
      rev: outcome.rev,
      verb: verb.type,
      opId,
      grid: applyPaneLabels(outcome.rows, new Map()),
    });
  }
  return { status: 'ok', rev: outcome.rev, grid, applied: outcome.applied };
}

/**
 * Re-exported, not redeclared. This name existed here AND in the client store,
 * structurally identical and related by nothing — so the GET's producer and its
 * only consumer could drift without a type error. The wire shape now has one
 * home (`packages/lib`), which is also the only place the client can reach: it
 * cannot import this module, which pulls in `@pagespace/db`.
 */
import type { WorkspaceLayoutSnapshot } from '@pagespace/lib/agent-workspaces/workspace-layout-wire';
export type { WorkspaceLayoutSnapshot };

/**
 * Who a labelled grid is being derived FOR.
 *
 * Labels are a PERMISSIONED join (security review HIGH 1), not free display
 * data: a pane's `targetId` is whatever the verb that bound it supplied, so
 * resolving a title without asking "may this viewer see it" turned the layout
 * read into a title oracle over every conversation, shell, and page in the
 * system. Every read path therefore names its viewer.
 *
 * `null` means NOBODY — the grid comes back label-free (structure, ids, and
 * size shares only). That is the honest shape for the two paths that have no
 * single viewer to redact for: the `session:<id>` room broadcast, which fans
 * out to every member at once, and the server-side placement helpers, which
 * discard the grid entirely.
 */
export type LabelViewerId = string | null;

/**
 * Turn persisted rows into the wire grid, joining every bound pane's display
 * label at READ time — the conversation title, the shell name, the page
 * title, and the conversation's own `contextId` as `agentPageId`. This is
 * the whole reason rows carry no `name`: a renamed conversation can never
 * leave a stale pane label behind (the drift class the dead blob carried).
 *
 * Every label is gated on `viewerId`; see {@link resolvePaneLabels}.
 */
async function labelGrid(
  workspaceId: string,
  grid: LayoutGridColumn[],
  viewerId: LabelViewerId,
): Promise<WorkspaceLayoutGridDTO> {
  if (grid.length === 0) return [];
  if (viewerId === null) return applyPaneLabels(grid, new Map());
  const labels = await resolvePaneLabels([{ workspaceId, grid }], viewerId);
  return applyPaneLabels(grid, labels.get(workspaceId) ?? new Map());
}

/** The pure half of {@link labelGrid} — rows + resolved labels → the wire grid. */
function applyPaneLabels(grid: LayoutGridColumn[], labels: Map<string, PaneLabel>): WorkspaceLayoutGridDTO {
  // Fractions come straight off the rows (issue #2208) — unlike labels there
  // is nothing to re-derive, and unlike focus they are not client-local. An
  // unsized container carries no key, matching what the reducer produces.
  return grid.map((column) => {
    const width = readFraction(column.widthFraction);
    return {
    id: column.id,
    ...(width !== null ? { widthFraction: width } : {}),
    panes: column.panes.map((pane) => {
      const settledHeight = readFraction(pane.heightFraction);
      const height = settledHeight !== null ? { heightFraction: settledHeight } : {};
      if (pane.kind === null) return { id: pane.id, scope: null, ...height };
      const label = pane.targetId !== null ? labels.get(`${pane.kind}:${pane.targetId}`) : undefined;
      const scope: PaneScope = {
        kind: pane.kind,
        targetId: pane.targetId,
        name: label?.name ?? '',
        agentPageId: label?.agentPageId ?? null,
      };
      return { id: pane.id, scope, ...height };
    }),
    };
  });
}

/**
 * The layout GET's rev-carrying snapshot: the labelled grid derived from the
 * relational rows, `null` when the session has no rows. Read-only and
 * lock-free: a racing verb just means the snapshot is one rev behind, which
 * the rev itself reports.
 */
export async function readWorkspaceLayoutSnapshot(
  workspaceId: string,
  viewerId: LabelViewerId,
): Promise<WorkspaceLayoutSnapshot> {
  const store = await createDbWorkspaceLayoutStore();
  const [grid, rev] = await Promise.all([store.getWorkspaceGrid(workspaceId), store.currentRev(workspaceId)]);
  if (grid.length === 0) return { rev, grid: null };
  return { rev, grid: await labelGrid(workspaceId, grid, viewerId) };
}

/**
 * MANY sessions' labelled grids in one pass — the sessions-list GET's shape
 * (polled by every open sidebar, so the per-session read this replaced was
 * 2N queries a tick). Two row queries and ONE label resolution across every
 * session's panes together; a session with no rows simply has no entry.
 */
export async function readWorkspaceGridsBulk(
  workspaceIds: string[],
  viewerId: LabelViewerId,
): Promise<Map<string, WorkspaceLayoutGridDTO>> {
  const labelled = new Map<string, WorkspaceLayoutGridDTO>();
  if (workspaceIds.length === 0) return labelled;

  const store = await createDbWorkspaceLayoutStore();
  const grids = await store.getWorkspaceGridsBulk(workspaceIds);
  if (grids.size === 0) return labelled;

  // One resolution across every listed workspace, but authorized PER
  // workspace: the redaction rule turns on who owns the workspace a pane sits
  // in, so a shared listing cannot borrow the viewer's authority in their own
  // workspace to unmask a pane in someone else's.
  const labels =
    viewerId === null
      ? new Map<string, Map<string, PaneLabel>>()
      : await resolvePaneLabels(
          [...grids].map(([workspaceId, grid]) => ({ workspaceId, grid })),
          viewerId,
        );
  for (const [workspaceId, grid] of grids) {
    labelled.set(workspaceId, applyPaneLabels(grid, labels.get(workspaceId) ?? new Map()));
  }
  return labelled;
}

/**
 * The sessions-list wire shape, rebuilt from rows. The list has always served
 * a whole `PersistedWorkspaceState` (once the blob, now this), and old
 * clients still read it that way, so the shape is preserved exactly — but the
 * two view-state fields have no server-side owner any more: focus is
 * client-local (#2048), so `activePaneId` is a well-formed DEFAULT (the first
 * pane) rather than a restored fact, and nothing is ever pending-picker on a
 * read. `null` for a session with no grid, exactly as before.
 */
export function workspaceListEntryFromGrid(
  workspaceId: string,
  grid: WorkspaceLayoutGridDTO | null,
): PersistedWorkspaceState | null {
  const firstPaneId = grid?.find((column) => column.panes.length > 0)?.panes[0].id;
  if (!grid || firstPaneId === undefined) return null;
  return { id: workspaceId, columns: grid, activePaneId: firstPaneId, pendingPickerPaneId: null };
}

interface PaneLabel {
  name: string;
  agentPageId: string | null;
}

/** One workspace's rows, for a label resolution that may span several of them. */
interface LabelSubject {
  workspaceId: string;
  grid: LayoutGridColumn[];
}

/**
 * Bulk-resolve every bound pane's display label FOR ONE VIEWER, across any
 * number of workspaces at once — one query per target kind however many
 * workspaces are in play (the bulk list read's whole point), then one
 * authorization pass per workspace.
 *
 * **A label is authority, so every kind has a gate** (security review HIGH 1):
 *
 *  - `chat` — the conversation must be genuinely IN the workspace whose grid
 *    this is, or be one the viewer may access on its own footing
 *    (`canAccessConversation`'s rule: their own thread, or a shared page
 *    thread whose page they can view). Containment is the load-bearing half:
 *    without it, an attacker who binds a foreign conversation into a
 *    workspace they OWN passes the redaction rule's owner branch and reads
 *    the real title. The title that survives that gate still goes through
 *    `redactConversationTitleForViewer` — the epic's ONE listing rule — so a
 *    drive member looking into a shared workspace sees the same
 *    `(private thread)` marker `list_sessions` shows them.
 *  - `terminal` — the shell must belong to THIS workspace. Shells are
 *    workspace-scoped rows, so containment is exact, and it lines up the pane
 *    label with what the shells route (gated on session access alone) already
 *    serves the same viewer.
 *  - `page` — the viewer must have page access (`getUserAccessLevel`). Pages
 *    are not workspace-scoped at all, so their own ACL is the only answer.
 *
 * A target that fails its gate — or no longer exists — simply resolves no
 * label: the pane keeps its ROW and renders with an empty name, exactly as
 * the blob behaved for deleted targets. Refusing to resolve is deliberately
 * indistinguishable from "gone", so the label join is not an existence
 * oracle either.
 */
async function resolvePaneLabels(
  subjects: readonly LabelSubject[],
  viewerId: string,
): Promise<Map<string, Map<string, PaneLabel>>> {
  const chatIds = new Set<string>();
  const shellIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const subject of subjects) {
    for (const column of subject.grid) {
      for (const pane of column.panes) {
        if (pane.kind === null || pane.targetId === null) continue;
        // Exhaustive on purpose: a new PaneKind that falls off the end of an
        // if/else chain collects no ids, so it resolves no label and renders
        // blank — a silent hole rather than a build failure.
        switch (pane.kind) {
          case 'chat':
            chatIds.add(pane.targetId);
            break;
          case 'terminal':
            shellIds.add(pane.targetId);
            break;
          case 'page':
            pageIds.add(pane.targetId);
            break;
          default: {
            const _exhaustive: never = pane.kind;
            void _exhaustive;
          }
        }
      }
    }
  }

  const workspaceIds = subjects.map((subject) => subject.workspaceId);
  const [chatRows, shellRows, pageRows, workspaceRows] = await Promise.all([
    chatIds.size > 0
      ? db
          .select({
            id: conversations.id,
            title: conversations.title,
            type: conversations.type,
            contextId: conversations.contextId,
            // The two facts the redaction rule needs, plus the binding that
            // decides whether this conversation belongs in the grid at all.
            userId: conversations.userId,
            isShared: conversations.isShared,
            // MEMBERSHIP, from the node that binds the thread. This read the
            // conversation's own `workspaceId` column until membership moved
            // into the tree; the containment rule below is unchanged in what it
            // asks, only in where the answer comes from. A LEFT join, so a
            // thread that belongs to no workspace still resolves (as null) —
            // an inner one would silently drop it and take its title with it.
            workspaceId: agentWorkspaceNodes.rootId,
          })
          .from(conversations)
          .leftJoin(
            agentWorkspaceNodes,
            and(
              eq(agentWorkspaceNodes.targetId, conversations.id),
              eq(agentWorkspaceNodes.targetKind, 'chat'),
            ),
          )
          .where(inArray(conversations.id, [...chatIds]))
      : Promise.resolve([]),
    shellIds.size > 0
      ? db
          .select({
            id: agentWorkspaceShells.id,
            name: agentWorkspaceShells.name,
            workspaceId: agentWorkspaceShells.workspaceId,
          })
          .from(agentWorkspaceShells)
          .where(inArray(agentWorkspaceShells.id, [...shellIds]))
      : Promise.resolve([]),
    pageIds.size > 0
      ? db.select({ id: pages.id, title: pages.title }).from(pages).where(inArray(pages.id, [...pageIds]))
      : Promise.resolve([]),
    workspaceIds.length > 0
      ? db
          .select({ id: agentWorkspaces.id, ownerId: agentWorkspaces.ownerId })
          .from(agentWorkspaces)
          .where(inArray(agentWorkspaces.id, workspaceIds))
      : Promise.resolve([]),
  ]);

  // Both viewer-scoped gates, resolved once per distinct target rather than
  // once per pane — the same viewer answers the same question every time.
  const [readablePages, accessibleConversations] = await Promise.all([
    resolveReadablePages(pageRows, viewerId),
    resolveAccessibleConversations(chatRows, viewerId),
  ]);

  const owners = new Map(workspaceRows.map((row) => [row.id, row.ownerId]));
  const byWorkspace = new Map<string, Map<string, PaneLabel>>();
  for (const subject of subjects) {
    // An unknown owner never matches a viewer, so the redaction rule's owner
    // branch fails closed on a workspace row that has vanished.
    const workspaceOwnerId = owners.get(subject.workspaceId) ?? '';
    const labels = new Map<string, PaneLabel>();

    for (const row of chatRows) {
      const belongsHere = row.workspaceId === subject.workspaceId;
      if (!belongsHere && !accessibleConversations.has(row.id)) continue;
      labels.set(`chat:${row.id}`, {
        name:
          redactConversationTitleForViewer({
            viewerId,
            workspaceOwnerId,
            conversation: { ownerId: row.userId, isShared: row.isShared === true, title: row.title },
          }) ?? '',
        // THE shared derivation, not a local re-spelling. This used to read
        // `row.type === 'page' ? row.contextId : null` with a comment arguing
        // the missing `client` branch was safe here because panes never bind
        // client threads. That argument was true and beside the point: five
        // other sites made the same "safe" omission and a sixth invented a
        // third answer, which is exactly what one shared function prevents and
        // six careful comments do not.
        agentPageId: conversationPageId(row),
      });
    }
    for (const row of shellRows) {
      if (row.workspaceId !== subject.workspaceId) continue;
      labels.set(`terminal:${row.id}`, { name: row.name, agentPageId: null });
    }
    for (const row of pageRows) {
      if (!readablePages.has(row.id)) continue;
      labels.set(`page:${row.id}`, { name: row.title, agentPageId: null });
    }

    byWorkspace.set(subject.workspaceId, labels);
  }

  return byWorkspace;
}

/** The subset of `pageRows` this viewer may actually read. */
async function resolveReadablePages(
  pageRows: ReadonlyArray<{ id: string }>,
  viewerId: string,
): Promise<Set<string>> {
  const decided = await Promise.all(
    pageRows.map(async (row) => ((await getUserAccessLevel(viewerId, row.id)) !== null ? row.id : null)),
  );
  return new Set(decided.filter((id): id is string => id !== null));
}

/**
 * The subset of `chatRows` this viewer may access on the conversation's OWN
 * footing — their own thread, or a shared page thread whose page they can
 * view. Routed through `canAccessConversation`, the SAME predicate the `conv:`
 * room join and `/stream-join` enforce, rather than a second copy of the rule:
 * the owner branch short-circuits with no IO, so the whole set costs at most
 * one page check per shared thread.
 */
async function resolveAccessibleConversations(
  chatRows: ReadonlyArray<{ id: string; userId: string; isShared: boolean | null; type: string; contextId: string | null }>,
  viewerId: string,
): Promise<Set<string>> {
  const decided = await Promise.all(
    chatRows.map(async (row) => {
      const allowed = await canAccessConversation(
        viewerId,
        { userId: row.userId, isShared: row.isShared === true, type: row.type, contextId: row.contextId },
        { getPageAccess: async (userId, pageId) => (await getUserAccessLevel(userId, pageId)) !== null },
      );
      return allowed ? row.id : null;
    }),
  );
  return new Set(decided.filter((id): id is string => id !== null));
}
