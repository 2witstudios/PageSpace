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
  type SpawnSessionShellResult,
  type KillSessionShellResult,
  type ResolveSessionShellResult,
} from '@pagespace/lib/services/agent-sessions/session-shells';
import type { ShellDTO } from '@pagespace/lib/agent-sessions/contract';
import { getAgentSessionStore, getMachineHost } from './agent-sessions-runtime';

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

export async function resolveShellById(shellId: string): Promise<ResolveSessionShellResult> {
  const store = await getSessionShellStore();
  return resolveSessionShellById({ shellId, deps: { store } });
}

export async function killShellById(shellId: string): Promise<KillSessionShellResult> {
  const [store, host, sessionStore] = await Promise.all([
    getSessionShellStore(),
    getMachineHost(),
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
