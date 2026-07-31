/**
 * Production wiring for the session-shell services — DI of the DB-backed shell
 * store and the Sprites host into `spawnSessionShell` / `listSessionShells` /
 * `killSessionShellById` / `resolveSessionShellById`. Naming and kill-target
 * policy live in the pure `plan-spawn-session.ts`; nothing here decides.
 */

import {
  createDbSessionShellStore,
  type SessionShellStore,
} from '@pagespace/lib/services/agent-sessions/session-shells-store';
import {
  spawnSessionShell,
  listSessionShells,
  killSessionShellById,
  resolveSessionShellById,
  toShellDTO,
  type SpawnSessionShellResult,
  type KillSessionShellResult,
  type ResolveSessionShellResult,
} from '@pagespace/lib/services/agent-sessions/session-shells';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { agentSessionShells } from '@pagespace/db/schema/agent-sessions';
import type { ShellDTO } from '@pagespace/lib/agent-sessions/contract';
import { getAgentSessionStore, getSandboxHost } from './agent-sessions-runtime';

let shellStorePromise: ReturnType<typeof createDbSessionShellStore> | null = null;

export function getSessionShellStore(): Promise<SessionShellStore> {
  shellStorePromise ??= createDbSessionShellStore();
  return shellStorePromise;
}

export async function spawnShell(input: {
  sessionId: string;
  ownerId: string;
  name?: string;
}): Promise<SpawnSessionShellResult> {
  const store = await getSessionShellStore();
  return spawnSessionShell({
    sessionId: input.sessionId,
    ownerId: input.ownerId,
    name: input.name,
    deps: { store, now: () => new Date() },
  });
}

export async function listShells(sessionId: string): Promise<ShellDTO[]> {
  const store = await getSessionShellStore();
  return listSessionShells({ sessionId, deps: { store } });
}

/**
 * The shells of MANY sessions in one query, grouped by session — the
 * collection GET's shape (review M4: it ran one query per session per
 * sidebar poll). Same DTO projection as the per-session listing.
 */
export async function listShellsBulk(sessionIds: string[]): Promise<Map<string, ShellDTO[]>> {
  const grouped = new Map<string, ShellDTO[]>();
  if (sessionIds.length === 0) return grouped;
  const rows = await db
    .select()
    .from(agentSessionShells)
    .where(inArray(agentSessionShells.sessionId, sessionIds))
    .orderBy(agentSessionShells.createdAt);
  for (const row of rows) {
    const bucket = grouped.get(row.sessionId) ?? [];
    bucket.push(toShellDTO(row));
    grouped.set(row.sessionId, bucket);
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
      resolveSessionSandboxId: async (sessionId) => {
        const session = await sessionStore.findById(sessionId);
        if (!session || session.spriteTornDownAt !== null) return null;
        return session.sandboxId;
      },
    },
  });
}
