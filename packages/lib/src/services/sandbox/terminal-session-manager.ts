import { createHmac } from 'crypto';
import { SANDBOX_EGRESS_ALLOWLIST, SANDBOX_RESOURCE_CAPS } from './execution-policy';
import type { SandboxClient } from './session-manager';
import { loggers } from '../../logging/logger-config';

export interface TerminalSessionKeyInput {
  tenantId: string;
  driveId: string;
  pageId: string;
  secret: string;
}

const NAMESPACE_VERSION = 'terminal-session:v1';

export function deriveTerminalSessionKey({
  tenantId,
  driveId,
  pageId,
  secret,
}: TerminalSessionKeyInput): string {
  if (secret.length === 0) {
    throw new Error('deriveTerminalSessionKey requires a non-empty secret');
  }
  const payload = [NAMESPACE_VERSION, tenantId, driveId, pageId].join('\0');
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-sbx-${digest}`;
}

export type TerminalTeardownReason = 'idle' | 'session_end';
export type TerminalLifecycleIntent = 'run' | 'end';

export interface TerminalSessionRef {
  sandboxId: string;
  lastActiveAt: Date;
}

export type TerminalLifecyclePlan =
  | { action: 'create' }
  | { action: 'resume'; sandboxId: string }
  | { action: 'teardown'; sandboxId: string; reason: TerminalTeardownReason }
  | { action: 'noop' }
  | { action: 'deny' };

export interface PlanTerminalLifecycleInput {
  canRun: boolean;
  existingSession?: TerminalSessionRef | null;
  now: Date;
  idleTimeoutMs?: number;
  intent?: TerminalLifecycleIntent;
  /** When true, idle sessions return noop instead of teardown — Sprites hibernates the VM. */
  persistent?: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function planTerminalLifecycle({
  canRun,
  existingSession = null,
  now,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  intent = 'run',
  persistent = false,
}: PlanTerminalLifecycleInput): TerminalLifecyclePlan {
  // Cleanup is unconditional on 'end' intent — authorization never gates cleanup.
  if (intent === 'end') {
    return existingSession
      ? { action: 'teardown', sandboxId: existingSession.sandboxId, reason: 'session_end' }
      : { action: 'noop' };
  }

  // Resume re-authz: deny before considering any warm session so an unauthorized
  // actor is never handed back another session's state.
  if (!canRun) {
    return { action: 'deny' };
  }

  if (!existingSession) {
    return { action: 'create' };
  }

  const idleFor = now.getTime() - existingSession.lastActiveAt.getTime();
  if (idleFor >= idleTimeoutMs) {
    // Persistent sandboxes hibernate on their own — keep the session store record alive.
    if (persistent) return { action: 'noop' };
    return { action: 'teardown', sandboxId: existingSession.sandboxId, reason: 'idle' };
  }

  return { action: 'resume', sandboxId: existingSession.sandboxId };
}

export interface TerminalSessionRecord {
  sessionKey: string;
  pageId: string;
  sandboxId: string;
  userId: string;
  lastActiveAt: Date;
}

export interface TerminalSessionStore {
  findBySessionKey(sessionKey: string): Promise<TerminalSessionRecord | null>;
  save(input: { sessionKey: string; pageId: string; sandboxId: string; userId: string; now: Date }): Promise<void>;
  touch(args: { sessionKey: string; now: Date }): Promise<void>;
  remove(sessionKey: string): Promise<void>;
}

export interface AcquireTerminalSandboxInput {
  pageId: string;
  driveId: string;
  tenantId: string;
  userId: string;
  /** Caller re-checks authz every request and passes the result through to the planner. */
  canRun: boolean;
  deps: {
    store: TerminalSessionStore;
    client: SandboxClient;
    now: () => Date;
    secret: string;
  };
}

export type AcquireTerminalSandboxResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | { ok: false; reason: 'deny' | 'provision_failed' | 'error'; cause?: unknown };

async function safeStop(client: SandboxClient, sandboxId: string): Promise<boolean> {
  try {
    await client.stop({ sandboxId });
    return true;
  } catch {
    return false;
  }
}

async function safeRemove(store: TerminalSessionStore, sessionKey: string): Promise<void> {
  try {
    await store.remove(sessionKey);
  } catch {
    // best-effort
  }
}

async function safeTouch(store: TerminalSessionStore, sessionKey: string, now: Date): Promise<void> {
  try {
    await store.touch({ sessionKey, now });
  } catch {
    // best-effort
  }
}

async function provisionFreshTerminal({
  key,
  input,
}: {
  key: string;
  input: AcquireTerminalSandboxInput;
}): Promise<AcquireTerminalSandboxResult> {
  const { deps, pageId, userId, driveId } = input;
  const options = { egressAllowlist: SANDBOX_EGRESS_ALLOWLIST, caps: SANDBOX_RESOURCE_CAPS };

  let sandboxId: string;
  try {
    const handle = await deps.client.getOrCreate({ name: key, options });
    sandboxId = handle.sandboxId;
  } catch (error) {
    const meta = { reason: 'provision_failed', userId, pageId, driveId };
    if (error instanceof Error) {
      loggers.api.error('Terminal sandbox acquisition failed', error, meta);
    } else {
      loggers.api.error('Terminal sandbox acquisition failed', meta);
    }
    return { ok: false, reason: 'provision_failed', cause: error };
  }

  try {
    await deps.store.save({ sessionKey: key, pageId, userId, sandboxId, now: deps.now() });
  } catch (error) {
    // The sandbox exists but we could not record the link — tear it down to
    // prevent an unreachable, unaudited orphan.
    await safeStop(deps.client, sandboxId);
    return { ok: false, reason: 'provision_failed', cause: error };
  }

  return { ok: true, sandboxId, resumed: false };
}

export async function acquireTerminalSandbox(
  input: AcquireTerminalSandboxInput,
): Promise<AcquireTerminalSandboxResult> {
  const { deps, pageId, driveId, tenantId, userId, canRun } = input;

  // Fail closed if any namespacing component or the secret is missing.
  if (!deps.secret || !pageId || !driveId || !tenantId || !userId) {
    return { ok: false, reason: 'error' };
  }

  const key = deriveTerminalSessionKey({ tenantId, driveId, pageId, secret: deps.secret });

  try {
    const existing = await deps.store.findBySessionKey(key);

    const plan = planTerminalLifecycle({
      canRun,
      existingSession: existing
        ? { sandboxId: existing.sandboxId, lastActiveAt: existing.lastActiveAt }
        : null,
      now: deps.now(),
      intent: 'run',
      // Sprites hibernate when idle and wake on demand, so an idle terminal VM
      // must be resumed, not destroyed — `persistent` makes the planner return
      // `noop` on idle (handled below as a reconnect) instead of `teardown`.
      persistent: true,
    });

    // Reconnect to a known-live (possibly hibernating) sandbox, re-provisioning
    // under the same key only if it has genuinely vanished. Shared by `resume`
    // (within the warm window) and `noop` (persistent-idle: the VM is sleeping,
    // not gone — wake it).
    const reconnectExisting = async (sandboxId: string): Promise<AcquireTerminalSandboxResult> => {
      const handle = await deps.client.get({ sandboxId });
      if (!handle) {
        await deps.store.remove(key);
        return await provisionFreshTerminal({ key, input });
      }
      await safeTouch(deps.store, key, deps.now());
      return { ok: true, sandboxId: handle.sandboxId, resumed: true };
    };

    switch (plan.action) {
      case 'deny':
        return { ok: false, reason: 'deny' };

      case 'create':
        return await provisionFreshTerminal({ key, input });

      case 'resume':
        return await reconnectExisting(plan.sandboxId);

      case 'noop':
        // Persistent-idle: existing is guaranteed (noop only arises with a session).
        return existing
          ? await reconnectExisting(existing.sandboxId)
          : { ok: false, reason: 'error' };

      case 'teardown': {
        const stopped = await safeStop(deps.client, plan.sandboxId);
        if (!stopped) {
          // VM may still be running — keep the link so the idle reaper can reclaim it.
          return { ok: false, reason: 'error' };
        }
        await safeRemove(deps.store, key);
        return await provisionFreshTerminal({ key, input });
      }

      default:
        return { ok: false, reason: 'error' };
    }
  } catch (error) {
    return { ok: false, reason: 'error', cause: error };
  }
}

/**
 * Production DB-backed implementation of TerminalSessionStore.
 * Lazily resolves the db client, schema table, and `eq` operator so callers
 * that inject a fake (in tests) never load the DB module graph.
 */
export async function createDbTerminalSessionStore(): Promise<TerminalSessionStore> {
  const [{ db }, { eq }, { terminalSessions }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/terminal-sessions'),
  ]);

  return {
    async findBySessionKey(sessionKey) {
      const [row] = await db
        .select()
        .from(terminalSessions)
        .where(eq(terminalSessions.sessionKey, sessionKey))
        .limit(1);
      if (!row) return null;
      return {
        sessionKey: row.sessionKey,
        pageId: row.pageId,
        sandboxId: row.sandboxId,
        userId: row.userId,
        lastActiveAt: row.lastActiveAt,
      };
    },

    async save({ sessionKey, pageId, sandboxId, userId, now }) {
      await db
        .insert(terminalSessions)
        .values({ sessionKey, pageId, sandboxId, userId, lastActiveAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: terminalSessions.sessionKey,
          set: { sandboxId, userId, lastActiveAt: now, updatedAt: now },
        });
    },

    async touch({ sessionKey, now }) {
      await db
        .update(terminalSessions)
        .set({ lastActiveAt: now, updatedAt: now })
        .where(eq(terminalSessions.sessionKey, sessionKey));
    },

    async remove(sessionKey) {
      await db.delete(terminalSessions).where(eq(terminalSessions.sessionKey, sessionKey));
    },
  };
}
