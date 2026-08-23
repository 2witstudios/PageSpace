/**
 * Production wiring for the session-shell services — DI of the DB-backed shell
 * store and the Sprites host into `spawnSessionShell` / `listSessionShells` /
 * `killSessionShellById` / `resolveSessionShellById`. Naming and kill-target
 * policy live in the pure `plan-spawn-worker.ts`; nothing here decides.
 */

import {
  createDbSessionShellStore,
  type SessionShellStore,
} from '@pagespace/lib/services/agent-workspaces/workspace-shells-store';
import {
  spawnSessionShell,
  listSessionShells,
  dropSessionShellRow,
  killShellProcess,
  resolveSessionShellById,
  toShellDTO,
  type SpawnSessionShellResult,
  type KillSessionShellResult,
  type ResolveSessionShellResult,
} from '@pagespace/lib/services/agent-workspaces/workspace-shells';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { agentWorkspaceShells } from '@pagespace/db/schema/agent-workspaces';
import type { ShellDTO } from '@pagespace/lib/agent-workspaces/shells-contract';
import { admit, expel, memberNode } from '@pagespace/lib/agent-workspaces/workspace-membership';
import type { PaneTarget, WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { createId } from '@paralleldrive/cuid2';
import { getAgentSessionStore, getSandboxHost, resolveSessionLiveSandboxId } from './agent-workspaces-runtime';
import { applyWorkspaceMembershipWrite } from './workspace-node-runtime';

/**
 * The shell row could not be reserved — an invalid or duplicate name, or a lost
 * race. Thrown so the membership transaction UNWINDS: a node binding a terminal
 * that does not exist is precisely the dangling pane this chokepoint prevents,
 * and returning a refusal from inside the transaction would commit one.
 *
 * Private: `spawnShell` catches the unwind by seeing the write refused, and
 * reports the shell service's own reason rather than this class.
 */
class ShellSpawnRefused extends Error {
  constructor() {
    super('shell_spawn_refused');
    this.name = 'ShellSpawnRefused';
  }
}

/**
 * The shell's ROW could not be dropped, so its pane must stay. Thrown for the
 * same reason {@link ShellSpawnRefused} is: the membership transaction UNWINDS,
 * and a pane removed for a shell the workspace still holds is the inverse of
 * the dangling pane this chokepoint prevents.
 *
 * The PROCESS is not what this defends — that is killed before the transaction
 * opens, precisely so a slow provider cannot hold the lock (see
 * {@link killShellById}).
 */
class ShellKillRefused extends Error {
  constructor() {
    super('shell_kill_refused');
    this.name = 'ShellKillRefused';
  }
}

/**
 * WHAT THE WORKSPACE LOOKS LIKE after a shell arrived or left — the answer to
 * "is anything piling up?", carried back by the write that changed it.
 *
 * It exists because an agent had no way to ask. `list_panes` has been there all
 * along, and the session that filed issue #2469 did not call it once: nothing
 * in a spawn or a kill response mentioned panes, so there was no moment at
 * which looking at the layout was the obvious next thing to do. A count on the
 * response the agent is already reading is that moment.
 *
 * Cheap by construction — the write funnel already read the tree it committed,
 * so this is a filter over nodes in hand, not a second query.
 */
export interface WorkspacePaneState {
  /** Every pane the workspace holds AFTER the write. Every pane is on screen; there is nowhere else for one to be. */
  paneCount: number;
  /**
   * THIS SHELL'S pane: the one a spawn opened, or the one a kill closed —
   * `null` when the workspace held none for it, which is the ordinary state
   * for a kill whose pane a human had already closed.
   *
   * A kill reports the node it REMOVED rather than the nothing it left, because
   * the id is what an agent correlates its own `list_panes` reading against;
   * "the pane is gone" is what `paneCount` already says.
   */
  nodeId: string | null;
}

/** A kill's outcome, plus what it left the layout looking like. `panes` is null when there was no workspace to look at. */
export type KillShellResult =
  | { ok: true; killed: boolean; panes: WorkspacePaneState | null }
  | { ok: false; reason: 'error' };

/** A spawn's outcome, plus the pane it landed in. */
export type SpawnShellResult =
  | { ok: true; shell: ShellDTO; panes: WorkspacePaneState }
  | Extract<SpawnSessionShellResult, { ok: false }>;

/**
 * The layout after a write, with the pane this shell owns named by the CALLER.
 *
 * The id is a parameter rather than a lookup because the two callers know it at
 * different moments: a spawn reads it out of the tree the write produced, and a
 * kill has to have read it BEFORE — by the time these nodes exist, the pane it
 * is reporting is gone from them.
 */
function paneStateOf(nodes: readonly WorkspaceNode[], nodeId: string | null): WorkspacePaneState {
  return { paneCount: nodes.filter((node) => node.nodeType === 'pane').length, nodeId };
}

/**
 * The service's own result, plus the layout the committed write left behind.
 *
 * A FUNCTION rather than two lines at the call site, and the parameter is the
 * reason: both callers hold the outcome in a `let` the transaction body
 * assigns, and TypeScript's flow analysis does not see through a callback — so
 * at the point of use it still believes the variable is the failure it was
 * initialized to. Passing it through a typed parameter is where the declared
 * union comes back, without an assertion claiming to know something the
 * compiler does not.
 */
function spawnedWithPanes(
  spawned: SpawnSessionShellResult,
  nodes: readonly WorkspaceNode[],
  target: PaneTarget,
): SpawnShellResult {
  if (!spawned.ok) return spawned;
  return { ok: true, shell: spawned.shell, panes: paneStateOf(nodes, memberNode(nodes, target)?.id ?? null) };
}

/** {@link spawnedWithPanes}'s counterpart, for the same reason. */
function killedWithPanes(
  killed: KillSessionShellResult,
  nodes: readonly WorkspaceNode[],
  closedNodeId: string | null,
): KillShellResult {
  if (!killed.ok) return killed;
  return { ok: true, killed: killed.killed, panes: paneStateOf(nodes, closedNodeId) };
}

/**
 * The OWNING session's live sandbox, which is where a shell's PTY (if one was
 * ever launched) runs — a shell has no Sprite pointer of its own. `null` when
 * the session has none, including a torn-down one: then there is no PTY to
 * kill.
 *
 * Through `resolveSessionLiveSandboxId` rather than off the session row: an
 * env-bound session's own pointer is permanently null, and reading that would
 * skip `killSession` while still dropping the shell row — leaving the PTY
 * running on the ENVIRONMENT's shared, long-lived VM with nothing left pointing
 * at it, and telling the caller it was killed.
 */
async function resolveOwningSandboxId(
  sessionStore: Awaited<ReturnType<typeof getAgentSessionStore>>,
  workspaceId: string,
): Promise<string | null> {
  const session = await sessionStore.findById(workspaceId);
  if (!session) return null;
  return resolveSessionLiveSandboxId(session);
}

let shellStorePromise: ReturnType<typeof createDbSessionShellStore> | null = null;

export function getSessionShellStore(): Promise<SessionShellStore> {
  shellStorePromise ??= createDbSessionShellStore();
  return shellStorePromise;
}

/**
 * Open a shell in a workspace — the ROW and the node that makes it a member,
 * in one transaction.
 *
 * The same chokepoint the conversation path goes through, for the same reason.
 * A shell row landing without a node is a terminal the workspace holds and
 * cannot show: `agent_workspace_shells.workspaceId` said it was there while the
 * pane rows said it was not, which is the two-structure split this epic deletes
 * wearing a different hat. Here the node IS the membership, and the shell's own
 * row is created on the transaction that writes it.
 *
 * **It arrives ON SCREEN**, because there is nowhere else for a member to be.
 * It used to arrive PARKED — in the workspace, off the grid — to avoid placing a
 * SECOND pane beside the one the shells route's own client mints and then binds.
 * That is no longer the trade: the placement policy this admission runs fills an
 * UNBOUND pane and splits only when there is none, so the client's waiting pane
 * IS what gets filled, and the client's own bind afterwards asks for a state the
 * node is already in. Two panes for one shell was in fact the OLD outcome — the
 * parked node and the client's bound one both held the same shell, invisibly,
 * because terminals carry no uniqueness index.
 */
export async function spawnShell(input: {
  workspaceId: string;
  ownerId: string;
  name?: string;
  /**
   * The pane a human picked into — see `AdmitConversationInput.activeNodeId`.
   * A terminal admits exactly the way a conversation does, so it places blind
   * without one: with two empty panes the policy falls to the first that
   * qualifies, and the shell opens somewhere the user did not point at.
   */
  activeNodeId?: string;
}): Promise<SpawnShellResult> {
  // The shell's id is minted HERE rather than by the column's default, because
  // the node that binds it is decided against the tree BEFORE the row exists —
  // inside the same transaction, so a server-generated id would not be knowable
  // in time. Caller-minted ids are the node model's own convention anyway.
  const shellId = createId();
  const target: PaneTarget = { kind: 'terminal', id: shellId };
  let spawned: SpawnSessionShellResult = { ok: false, reason: 'error' };

  try {
    const written = await applyWorkspaceMembershipWrite({
      workspaceId: input.workspaceId,
      actingUserId: input.ownerId,
      run: (nodes) =>
        admit(nodes, {
          target,
          newNodeId: createId(),
          newSplitId: createId(),
          ...(input.activeNodeId === undefined ? {} : { activeNodeId: input.activeNodeId }),
        }),
      within: async (tx) => {
        const store = await createDbSessionShellStore(tx);
        spawned = await spawnSessionShell({
          shellId,
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
          name: input.name,
          deps: { store, now: () => new Date() },
        });
        // The shell service's refusals — an invalid name, a `(workspaceId,
        // name)` collision — have to take the node with them, so they unwind
        // rather than return.
        if (!spawned.ok) throw new ShellSpawnRefused();
      },
    });
    if (written.status !== 'ok') return { ok: false, reason: 'error' };
    // The pane it landed in, and how many the workspace now holds — read off
    // the snapshot the write already returned. See {@link WorkspacePaneState}.
    return spawnedWithPanes(spawned, written.snapshot.nodes, target);
  } catch (error) {
    // The row was refused and the node went back with it. The caller gets the
    // shell service's own reason, which is the one they can act on.
    if (error instanceof ShellSpawnRefused) return spawned;
    throw error;
  }
}

export async function listShells(workspaceId: string): Promise<ShellDTO[]> {
  const store = await getSessionShellStore();
  return listSessionShells({ workspaceId, deps: { store } });
}

/**
 * The shells of MANY sessions in one query, grouped by session — the
 * collection GET's shape (review M4: it ran one query per session per
 * sidebar poll). Same DTO projection as the per-session listing.
 */
export async function listShellsBulk(workspaceIds: string[]): Promise<Map<string, ShellDTO[]>> {
  const grouped = new Map<string, ShellDTO[]>();
  if (workspaceIds.length === 0) return grouped;
  const rows = await db
    .select()
    .from(agentWorkspaceShells)
    .where(inArray(agentWorkspaceShells.workspaceId, workspaceIds))
    .orderBy(agentWorkspaceShells.createdAt);
  for (const row of rows) {
    const bucket = grouped.get(row.workspaceId) ?? [];
    bucket.push(toShellDTO(row));
    grouped.set(row.workspaceId, bucket);
  }
  return grouped;
}

export async function resolveShellById(shellId: string): Promise<ResolveSessionShellResult> {
  const store = await getSessionShellStore();
  return resolveSessionShellById({ shellId, deps: { store } });
}

/**
 * Close a shell — the PTY, the ROW and the PANE, in one transaction.
 *
 * **THE MIRROR OF {@link spawnShell}, and it was missing.** Spawn wrapped the
 * row and the node that shows it in one membership write; kill terminated the
 * process and dropped the row and said nothing to the tree at all. So a shell
 * an agent opened arrived on screen and a shell it killed left its pane
 * standing, bound to a terminal that no longer existed — no broadcast, no
 * repair, and no signal to the agent that anything was left behind. Panes could
 * only accumulate until a human closed them (issue #2462), which is what the
 * session that reported it spent its afternoon doing.
 *
 * `expel` is the removal `admit` is the arrival of, so this is that function
 * pointed the other way rather than a second removal beside it.
 *
 * **THE SPRITE CALL IS OUTSIDE THE LOCK, and the two DATABASE facts are inside
 * it.** That split is the whole shape of this function, and it is
 * {@link destroyWorkspaceTree}'s rule rather than an exception to it: a network
 * call to the sandbox provider inside a workspace's advisory lock lets a slow
 * provider block every layout write for that workspace. "Slow" is not
 * hypothetical here — `killSpriteSession` retries three times at 10s apiece
 * with backoff, and its own doc says the REST call may itself be what WAKES a
 * hibernating Sprite, so half a minute is a normal slow path. An earlier cut of
 * this function held the lock across it, on the argument that the row and the
 * process should be atomic; a review (CodeRabbit, and the branch's own review
 * pass) priced that argument correctly, and it was not worth what it cost.
 *
 * What atomicity actually has to buy is the row and the NODE agreeing, because
 * a row without a node is the dangling pane this exists to close and a node
 * without a row is the same defect mirrored. Those are both database facts and
 * they are still one transaction.
 *
 * **What is left is one residue, and it self-heals.** The PTY kill is external
 * and comes first, so a transaction that fails after it cannot take it back:
 * the row and the pane survive, pointing at a dead process. That state is
 * indistinguishable from a shell whose process exited on its own, it is VISIBLE
 * (the pane is there), and the next close runs this again — `killSession`
 * against an already-dead id is idempotent, so the retry lands. The
 * predecessor's failure mode was the opposite one: invisible.
 */
export async function killShellById(input: {
  shellId: string;
  /** The acting HUMAN, for the membership write's own funnel. Nothing new is bound by a removal, so the gate has nothing to judge — but the funnel takes one. */
  actingUserId: string;
}): Promise<KillShellResult> {
  const { shellId, actingUserId } = input;
  const [store, host, sessionStore] = await Promise.all([
    getSessionShellStore(),
    getSandboxHost(),
    getAgentSessionStore(),
  ]);

  // WHICH workspace, read before the lock — the membership write is addressed
  // by workspace and the shell row is the only thing that knows which one this
  // is. A shell that is already gone has no workspace, no pane and nothing to
  // kill, which is `planKillTarget`'s success (see `killSessionShellById`).
  const row = await store.findById(shellId);
  if (!row) return { ok: true, killed: false, panes: null };

  // THE PROCESS, killed before anything takes a lock — see the doc above for
  // why this is not inside the transaction. A failure here means we learned
  // NOTHING about the process, so nothing is written at all: the row and the
  // pane both stay, and the caller retries.
  const process = await killShellProcess({
    row,
    deps: {
      host,
      resolveSessionSandboxId: async (workspaceId) => resolveOwningSandboxId(sessionStore, workspaceId),
    },
  });
  if (!process.ok) return { ok: false, reason: 'error' };

  let killed: KillSessionShellResult = { ok: false, reason: 'error' };
  // The pane this kill closes, read from the tree the decision ran against —
  // afterwards there is nothing left to read it from. It is what the agent
  // correlates against its own `list_panes`.
  let closedNodeId: string | null = null;
  const target: PaneTarget = { kind: 'terminal', id: shellId };

  try {
    const written = await applyWorkspaceMembershipWrite({
      workspaceId: row.workspaceId,
      actingUserId,
      // A removal never needs a root minted for it — see the flag's own doc.
      seed: false,
      run: (nodes) => {
        closedNodeId = memberNode(nodes, target)?.id ?? null;
        const result = expel(nodes, { target });
        // A shell whose pane a human already closed is the state this write
        // wanted: closing a terminal tab drops the node from the client and
        // THEN sends this DELETE, so `not_a_member` is the ordinary outcome of
        // the ordinary path, not a fault. Said here rather than in `expel`,
        // which is right to answer a caller that asked on a user's behalf with
        // the truth — see its own doc.
        if (!result.ok && result.code === 'not_a_member') return { ok: true, write: { put: [], drop: [] } };
        return result;
      },
      within: async (tx) => {
        // The ROW, on the transaction that is writing the node — the pair this
        // function exists to keep together. Nothing here leaves the database.
        killed = await dropSessionShellRow({ shellId, deps: { store: await createDbSessionShellStore(tx) } });
        // A row that could not be dropped has to take the node with it, so it
        // UNWINDS rather than returns: a pane removed for a shell the workspace
        // still holds is the inverse of the defect this closes.
        if (!killed.ok) throw new ShellKillRefused();
      },
    });
    if (written.status !== 'ok') return { ok: false, reason: 'error' };
    // `paneCount` is what the workspace is LEFT showing — the agent's trigger to
    // tidy up — and `nodeId` is the pane this kill took off the screen.
    return killedWithPanes(killed, written.snapshot.nodes, closedNodeId);
  } catch (error) {
    // The kill was refused and the node write went back with it. Nothing was
    // removed and nothing was left half-removed; the caller retries.
    if (error instanceof ShellKillRefused) return { ok: false, reason: 'error' };
    throw error;
  }
}
