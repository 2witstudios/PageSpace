/**
 * The node model's production wiring: THE read and THE write.
 *
 * Successor to `workspace-layout-runtime.ts`, and shorter for three reasons
 * that are all the same reason — the model underneath stopped having two of
 * everything.
 *
 *  * **The read is atomic.** `readWorkspaceNodes` returns `{rev, nodes}` from
 *    one statement (`readWorkspaceNodeSnapshots`), so the rev DESCRIBES the
 *    nodes rather than merely accompanying them. The pair the old snapshot read
 *    with `Promise.all([getWorkspaceGrid, currentRev])` could over-claim, and an
 *    over-claiming rev is not a cosmetic fault: the client adopts it as its
 *    base, and `applyRemoteUpdate`'s `payload.rev <= sync.rev` guard then drops
 *    the next real broadcast, leaving the client wrong until the next poll.
 *  * **There is no op memory.** The write primitive is an upsert of a node set,
 *    so a retried POST re-applies to the same state by construction; the
 *    `(workspaceId, opId)` row the verb path needed remembered something that
 *    can no longer happen.
 *  * **One shape serves one workspace and fifty.** The store's read takes a
 *    LIST, and the single case is that list with one element — so there is no
 *    second reader to keep in step with the first, and the sessions-list read is
 *    a wrapper rather than a second query.
 *
 * **What titles are, and where they live.** A node's `targetId` is whatever the
 * write that bound it supplied, so resolving a title without asking "may this
 * viewer see it" turns a layout read into a title oracle over every
 * conversation, shell and page in the system (security review HIGH 1). Titles
 * are therefore resolved and redacted ONCE PER VIEWER, and they ride BESIDE the
 * tree as `targets[]` rather than inside it — which is also what lets the
 * broadcast ship the whole tree to a room, since the tree is structural and
 * identical for every member while a title can only ever be part of an answer to
 * one caller.
 */

import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaceShells, agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { pages } from '@pagespace/db/schema/core';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';
import { redactConversationTitleForViewer } from '@pagespace/lib/agent-workspaces/redact-conversation-listing';
import type { PaneTargetKind, WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type {
  WireWorkspaceNode,
  WorkspaceNodeSnapshotResponse,
  WorkspaceNodeTarget,
} from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import { decideNodeWrite } from '@pagespace/lib/agent-workspaces/workspace-node-write';
import type { CommandCode, CommandResult } from '@pagespace/lib/agent-workspaces/workspace-node-commands';
import type { TreeViolationCode } from '@pagespace/lib/agent-workspaces/workspace-node-validate';
import {
  readWorkspaceNodeSnapshot,
  readWorkspaceNodeSnapshots,
  withWorkspaceLayoutLock,
  writeWorkspaceNodes,
  type WorkspaceNodeSnapshot,
} from '@pagespace/lib/services/agent-workspaces/workspace-node-store';
import { broadcastWorkspaceNodesUpdated } from '@/lib/websocket/agent-workspace-events';
import { authorizePaneTargets, introducedPaneTargets } from './authorize-pane-scope';

/**
 * Who a resolved target list is being derived FOR.
 *
 * `null` means NOBODY — no titles at all, which is the honest shape for the
 * server-side placement helpers: they discard the response entirely, so
 * resolving a title for them would be authority spent on nothing.
 */
export type TargetViewerId = string | null;

/**
 * THE READ. `{rev, nodes, targets}` for one workspace.
 *
 * Lock-free on purpose: the statement is its own snapshot, so a racing write
 * simply means this answer is a whole rev behind — which the rev reports, and
 * which the caller's next broadcast or poll closes. Taking the serializing lock
 * would make every sidebar poll queue behind every drag.
 */
export async function readWorkspaceNodes(
  workspaceId: string,
  viewerId: TargetViewerId,
): Promise<WorkspaceNodeSnapshotResponse> {
  const snapshot = await readWorkspaceNodeSnapshot(db, workspaceId);
  return {
    rev: snapshot.rev,
    nodes: snapshot.nodes,
    targets: await resolveTargets([{ workspaceId, nodes: snapshot.nodes }], viewerId, workspaceId),
  };
}

/*
 * MANY workspaces at once — the sessions-list read's shape — is deliberately
 * NOT here yet. The bulk READ exists and is the same statement
 * (`readWorkspaceNodeSnapshots`, one query for one workspace and for fifty),
 * and `resolveTargetsByWorkspace` below already takes a list of subjects and
 * authorizes each one against its OWN workspace's owner. What is missing is the
 * consumer: the sessions list still reads the old grid, and it moves in the
 * phase that moves the sidebar. Adding the wrapper now would be a dead export
 * that nothing exercises — the shape is proven by the store's own suite, and
 * the wrapper is two lines when its caller arrives.
 */

/** Why a write was refused. Every one of these writes NOTHING. */
export type NodeWriteRefusal = TreeViolationCode | 'foreign_scope' | 'forbidden_target' | CommandCode;

/** What the write answers. `stale` and `ok` carry the same body; the status code differs. */
export type ApplyWorkspaceNodeWriteResult =
  | { status: 'ok'; snapshot: WorkspaceNodeSnapshotResponse; changed: boolean }
  | { status: 'stale'; snapshot: WorkspaceNodeSnapshotResponse }
  | { status: 'refused'; code: NodeWriteRefusal; detail: string };

/**
 * What a caller wants written, decided against the tree the LOCK read.
 *
 * Two producers exist and they differ in exactly one way. A browser arrives
 * holding a tree it already reduced, so it sends nodes and a `baseRev` and the
 * rev check decides whether its arithmetic still applies. An agent arrives
 * holding nothing — it names a COMMAND ("show me this page"), the server
 * resolves it against the tree it is looking at, and there is no `baseRev`
 * because there is no stale snapshot to hold: `baseRev` is `rev`, always, and
 * the rebase loop the placement helpers used to run disappears with it.
 */
type WriteProducer = (
  nodes: readonly WorkspaceNode[],
  rev: number,
) =>
  | { status: 'write'; baseRev: number; put: readonly WireWorkspaceNode[]; drop: readonly string[] }
  | { status: 'refused'; code: NodeWriteRefusal; detail: string };

/**
 * THE ONE WRITE FUNNEL — lock, read, decide, gate, persist, broadcast.
 *
 * The whole read-decide-persist cycle is inside `withWorkspaceLayoutLock`,
 * because the lock closes a lost update only if the read that DECIDED the write
 * is in the same scope as the write itself. It is deliberately the same advisory
 * lock the legacy verb path takes, so during the migration window a node write
 * and a verb write for one workspace serialize against each other.
 *
 * **Nothing is repaired.** An invalid result is a refusal that writes nothing —
 * no re-parenting, no dropping of the offending node, no attaching a dangling
 * child to the root. A caller holding a stale snapshot is told to rebase; a
 * caller holding a broken one is told what broke.
 */
async function commitUnderLock(input: {
  workspaceId: string;
  /** Whose authority binds a NEW target. Always the acting HUMAN, never a model's word. */
  actingUserId: string;
  /** Who the answer's titles are for; `null` resolves none, for callers that discard the body. */
  viewerId: TargetViewerId;
  produce: WriteProducer;
}): Promise<ApplyWorkspaceNodeWriteResult> {
  const { workspaceId, actingUserId, viewerId, produce } = input;

  const outcome = await withWorkspaceLayoutLock(workspaceId, async (tx) => {
    const before = await readWorkspaceNodeSnapshot(tx, workspaceId);

    const wanted = produce(before.nodes, before.rev);
    if (wanted.status === 'refused') {
      return { kind: 'refused' as const, code: wanted.code, detail: wanted.detail };
    }

    const decision = decideNodeWrite({
      workspaceId,
      rev: before.rev,
      nodes: before.nodes,
      baseRev: wanted.baseRev,
      put: wanted.put,
      drop: wanted.drop,
    });

    if (decision.status === 'foreign_scope') {
      return { kind: 'refused' as const, code: 'foreign_scope' as const, detail: decision.detail };
    }
    if (decision.status === 'stale') return { kind: 'stale' as const, snapshot: before };
    if (decision.status === 'invalid') {
      return { kind: 'refused' as const, code: decision.code, detail: decision.detail };
    }

    // SESSION ACCESS IS NOT TARGET ACCESS. Reaching this workspace says nothing
    // about the ids a node points at — they are free-form in the body, and for
    // an agent tool they came out of a MODEL. So the bindings this write
    // INTRODUCES are settled before anything is persisted, against the acting
    // user's own authority. Inside the lock, against the tree the lock read: see
    // `introducedPaneTargets` for why a lock-free pre-read would leave a race
    // whose payoff is the disclosure this gate exists to stop.
    const introduced = introducedPaneTargets(before.nodes, decision.persist.put);
    if (introduced.length > 0) {
      const allowed = await authorizePaneTargets({ viewerId: actingUserId, workspaceId, targets: introduced });
      if (!allowed) {
        return {
          kind: 'refused' as const,
          code: 'forbidden_target' as const,
          detail: 'You cannot show that in this workspace.',
        };
      }
    }

    // A write that produces the tree already stored mints no rev and broadcasts
    // nothing — which is what makes a retried POST observably, and not merely
    // structurally, a no-op.
    if (!decision.changed) {
      return { kind: 'ok' as const, snapshot: before, changed: false };
    }

    const rev = await writeWorkspaceNodes(tx, { workspaceId, write: decision.persist });
    return { kind: 'ok' as const, snapshot: { rev, nodes: decision.nodes }, changed: true };
  });

  if (outcome.kind === 'refused') {
    return { status: 'refused', code: outcome.code, detail: outcome.detail };
  }

  // Titles resolve OUTSIDE the lock: they are derived display data, so a racing
  // rename just means this response carries the title from a moment ago — never
  // a reason to hold the per-workspace serializing lock over more IO.
  const snapshot = await withTargets(workspaceId, outcome.snapshot, viewerId);

  if (outcome.kind === 'stale') return { status: 'stale', snapshot };

  if (outcome.changed) {
    // Structural only, and to a ROOM. See the payload's own doc.
    broadcastWorkspaceNodesUpdated({
      workspaceId,
      rev: outcome.snapshot.rev,
      nodes: outcome.snapshot.nodes,
    });
  }
  return { status: 'ok', snapshot, changed: outcome.changed };
}

/** THE ROUTE'S WRITE: a client-computed `{baseRev, put, drop}`. */
export async function applyWorkspaceNodeWrite(input: {
  workspaceId: string;
  baseRev: number;
  put: readonly WireWorkspaceNode[];
  drop: readonly string[];
  viewerId: string;
}): Promise<ApplyWorkspaceNodeWriteResult> {
  const { workspaceId, baseRev, put, drop, viewerId } = input;
  return commitUnderLock({
    workspaceId,
    actingUserId: viewerId,
    viewerId,
    produce: () => ({ status: 'write', baseRev, put, drop }),
  });
}

/**
 * THE AGENT TOOLS' WRITE: a command the SERVER resolves against the tree it is
 * holding, inside the lock.
 *
 * **This is what retires the rebase loop.** The placement helpers used to read a
 * rev, compute a verb against it, POST, and retry up to three times while the
 * server answered `stale` — an optimistic-concurrency dance a server has no
 * reason to do with itself. A command resolved under the lock is decided against
 * the only tree that can still be there when it commits, so there is nothing to
 * rebase onto and no attempt budget to run out of.
 *
 * `run` gets the workspace's nodes and returns the command's compiled write, or
 * its refusal. Its operations are applied ATOMICALLY: `compile` returns one
 * write for all of them, and a refused step ends the command with no write at
 * all, so a caller either gets every edit or none.
 */
export async function applyWorkspaceNodeCommand(input: {
  workspaceId: string;
  /** The acting HUMAN. The ACL gate is theirs — never the model's word. */
  actingUserId: string;
  run: (nodes: readonly WorkspaceNode[]) => CommandResult;
}): Promise<ApplyWorkspaceNodeWriteResult> {
  const { workspaceId, actingUserId, run } = input;
  return commitUnderLock({
    workspaceId,
    actingUserId,
    // Nothing reads the body: these callers report `changed` and discard the
    // rest, so resolving a title for them would be authority spent on nothing.
    viewerId: null,
    produce: (nodes, rev) => {
      const result = run(nodes);
      if (!result.ok) return { status: 'refused', code: result.code, detail: result.detail };
      return { status: 'write', baseRev: rev, put: result.write.put, drop: result.write.drop };
    },
  });
}

async function withTargets(
  workspaceId: string,
  snapshot: WorkspaceNodeSnapshot,
  viewerId: TargetViewerId,
): Promise<WorkspaceNodeSnapshotResponse> {
  return {
    rev: snapshot.rev,
    nodes: snapshot.nodes,
    targets: await resolveTargets([{ workspaceId, nodes: snapshot.nodes }], viewerId, workspaceId),
  };
}

/** One workspace's nodes, for a resolution that may span several of them. */
interface TargetSubject {
  workspaceId: string;
  nodes: readonly WorkspaceNode[];
}

async function resolveTargets(
  subjects: readonly TargetSubject[],
  viewerId: TargetViewerId,
  workspaceId: string,
): Promise<WorkspaceNodeTarget[]> {
  const byWorkspace = await resolveTargetsByWorkspace(subjects, viewerId);
  return byWorkspace.get(workspaceId) ?? [];
}

/**
 * Bulk-resolve every bound node's target FOR ONE VIEWER, across any number of
 * workspaces at once — one query per kind however many workspaces are in play,
 * then one authorization pass per workspace.
 *
 * **A title is authority, so every kind has a gate** — the SAME three rules the
 * verb model's `resolvePaneLabels` applies, ported rather than re-derived:
 *
 *  - `chat` — the conversation must be genuinely IN the workspace whose tree
 *    this is, or be one the viewer may access on its own footing
 *    (`canAccessConversation`). Containment is the load-bearing half: without
 *    it, an attacker who binds a foreign conversation into a workspace they OWN
 *    passes the redaction rule's owner branch and reads the real title. What
 *    survives still goes through `redactConversationTitleForViewer`, the epic's
 *    ONE listing rule.
 *  - `terminal` — the shell must belong to THIS workspace. Shells are
 *    workspace-scoped rows, so containment is the whole rule.
 *  - `page` — the viewer must have page access. Pages are not workspace-scoped
 *    at all, so their own ACL is the only answer.
 *
 * A target that fails its gate — or no longer exists — simply has NO entry, so
 * refusing to resolve is indistinguishable from "gone" and the join is not an
 * existence oracle either. The NODE keeps its place in the tree regardless: a
 * pane whose title cannot be resolved still renders, exactly as it did when the
 * label came back empty.
 */
async function resolveTargetsByWorkspace(
  subjects: readonly TargetSubject[],
  viewerId: TargetViewerId,
): Promise<Map<string, WorkspaceNodeTarget[]>> {
  const empty = new Map<string, WorkspaceNodeTarget[]>();
  if (viewerId === null) {
    for (const subject of subjects) empty.set(subject.workspaceId, []);
    return empty;
  }

  const chatIds = new Set<string>();
  const shellIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const subject of subjects) {
    for (const node of subject.nodes) {
      if (node.nodeType !== 'pane' || node.target === null) continue;
      // Exhaustive on purpose: a new PaneTargetKind falling off the end of an
      // if/else chain would collect no ids, resolve no title, and render blank —
      // a silent hole rather than a build failure.
      switch (node.target.kind) {
        case 'chat':
          chatIds.add(node.target.id);
          break;
        case 'terminal':
          shellIds.add(node.target.id);
          break;
        case 'page':
          pageIds.add(node.target.id);
          break;
        default: {
          const _exhaustive: never = node.target.kind;
          void _exhaustive;
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
            userId: conversations.userId,
            isShared: conversations.isShared,
            workspaceId: conversations.workspaceId,
            // The ordering fact the sidebar needs once it stops reading
            // `session.conversations` — carried here rather than fetched a
            // second time, because it is authorized by exactly the gate the
            // title already passed.
            lastMessageAt: conversations.lastMessageAt,
          })
          .from(conversations)
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

  const [readablePages, accessibleConversations] = await Promise.all([
    resolveReadablePages(pageRows, viewerId),
    resolveAccessibleConversations(chatRows, viewerId),
  ]);

  const owners = new Map(workspaceRows.map((row) => [row.id, row.ownerId]));
  const resolved = new Map<string, WorkspaceNodeTarget[]>();
  for (const subject of subjects) {
    // An unknown owner never matches a viewer, so the redaction rule's owner
    // branch fails CLOSED on a workspace row that has vanished.
    const workspaceOwnerId = owners.get(subject.workspaceId) ?? '';
    // Only the targets this workspace's nodes actually point at: the queries
    // above span every subject at once, and a workspace must not learn a title
    // because some OTHER workspace in the same listing showed it.
    const wanted = new Set<string>();
    for (const node of subject.nodes) {
      if (node.nodeType === 'pane' && node.target !== null) wanted.add(`${node.target.kind}:${node.target.id}`);
    }
    const targets: WorkspaceNodeTarget[] = [];
    const push = (kind: PaneTargetKind, id: string, title: string, lastMessageAt: Date | null): void => {
      if (!wanted.has(`${kind}:${id}`)) return;
      targets.push({ id, kind, title, lastMessageAt: lastMessageAt?.toISOString() ?? null });
    };

    for (const row of chatRows) {
      const belongsHere = row.workspaceId === subject.workspaceId;
      if (!belongsHere && !accessibleConversations.has(row.id)) continue;
      const title = redactConversationTitleForViewer({
        viewerId,
        workspaceOwnerId,
        conversation: { ownerId: row.userId, isShared: row.isShared === true, title: row.title },
      });
      push('chat', row.id, title ?? '', row.lastMessageAt);
    }
    for (const row of shellRows) {
      if (row.workspaceId !== subject.workspaceId) continue;
      push('terminal', row.id, row.name, null);
    }
    for (const row of pageRows) {
      if (!readablePages.has(row.id)) continue;
      push('page', row.id, row.title, null);
    }

    resolved.set(subject.workspaceId, targets);
  }
  return resolved;
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
 * footing. Routed through `canAccessConversation` — the SAME predicate the
 * `conv:` room join and `/stream-join` enforce — rather than a second copy of
 * the rule.
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
