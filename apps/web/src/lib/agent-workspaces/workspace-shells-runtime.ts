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
  killSessionShellById,
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
import { admit } from '@pagespace/lib/agent-workspaces/workspace-membership';
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
}): Promise<SpawnSessionShellResult> {
  // The shell's id is minted HERE rather than by the column's default, because
  // the node that binds it is decided against the tree BEFORE the row exists —
  // inside the same transaction, so a server-generated id would not be knowable
  // in time. Caller-minted ids are the node model's own convention anyway.
  const shellId = createId();
  let spawned: SpawnSessionShellResult = { ok: false, reason: 'error' };

  try {
    const written = await applyWorkspaceMembershipWrite({
      workspaceId: input.workspaceId,
      actingUserId: input.ownerId,
      run: (nodes) =>
        admit(nodes, {
          target: { kind: 'terminal', id: shellId },
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
    return spawned;
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

export async function killShellById(shellId: string): Promise<KillSessionShellResult> {
  const [store, host, sessionStore] = await Promise.all([
    getSessionShellStore(),
    getSandboxHost(),
    getAgentSessionStore(),
  ]);
  return killSessionShellById({
    shellId,
    deps: {
      store,
      host,
      // A shell has no Sprite pointer of its own — the OWNING session's live
      // sandbox is where its PTY (if ever launched) runs. Null when the session
      // has none (nothing to kill), including a torn-down one.
      //
      // Resolved through `resolveSessionLiveSandboxId` rather than off the row:
      // an env-bound session's own pointer is permanently null, and reading it
      // here would skip `killSession` while still dropping the shell row —
      // leaving the PTY running on the ENVIRONMENT's shared, long-lived VM with
      // nothing left pointing at it, and telling the caller it was killed.
      resolveSessionSandboxId: async (workspaceId) => {
        const session = await sessionStore.findById(workspaceId);
        if (!session) return null;
        return resolveSessionLiveSandboxId(session);
      },
    },
  });
}
