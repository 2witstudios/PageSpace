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
import type { ShellDTO } from '@pagespace/lib/agent-workspaces/contract';
import { getAgentSessionStore, getSandboxHost } from './agent-workspaces-runtime';

let shellStorePromise: ReturnType<typeof createDbSessionShellStore> | null = null;

export function getSessionShellStore(): Promise<SessionShellStore> {
  shellStorePromise ??= createDbSessionShellStore();
  return shellStorePromise;
}

export async function spawnShell(input: {
  workspaceId: string;
  ownerId: string;
  name?: string;
}): Promise<SpawnSessionShellResult> {
  const store = await getSessionShellStore();
  return spawnSessionShell({
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    name: input.name,
    deps: { store, now: () => new Date() },
  });
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
      resolveSessionSandboxId: async (workspaceId) => {
        const session = await sessionStore.findById(workspaceId);
        if (!session || session.spriteTornDownAt !== null) return null;
        return session.sandboxId;
      },
    },
  });
}
