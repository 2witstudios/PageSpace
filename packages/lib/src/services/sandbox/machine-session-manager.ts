import { createHmac } from 'crypto';
import type { SandboxCreateOptions } from './sandbox-options';
import { resolveSandboxNetworkOptions } from './network-options';
import { getConfiguredEgressIpTag } from './egress-ip';
import type { FullEgressEnablement, FullEgressDenialReason } from './containment';
import { loggers } from '../../logging/logger-config';

/** Minimal sandbox handle the lifecycle needs. */
export interface SandboxHandle {
  sandboxId: string;
}

/**
 * The provider-agnostic slice of the sandbox client this layer drives, injected
 * so this lifecycle owns no execution path (the Fly Sprites driver implements
 * it). `getOrCreate` auto-resumes by `name` (the session key); `get` reconnects
 * to a known id (null if it has vanished); `stop` tears down.
 */
export interface SandboxClient {
  getOrCreate(args: { name: string; options: SandboxCreateOptions }): Promise<SandboxHandle>;
  get(args: { sandboxId: string }): Promise<SandboxHandle | null>;
  stop(args: { sandboxId: string }): Promise<void>;
}

/**
 * Read the session-key secret. Returns '' (→ fail-closed deny) when unset, so a
 * missing secret disables sandbox acquisition rather than throwing at the call
 * site.
 *
 * Read directly from `process.env`, NOT via `getValidatedEnv()`: this runs in the
 * realtime service too (terminal session keys), whose lean env does not satisfy
 * the full web schema — `getValidatedEnv()` would throw there, blanking the
 * secret and denying every terminal.
 */
export function getSandboxSessionSecret(): string {
  const secret = process.env.SANDBOX_SESSION_SECRET ?? '';
  // The web schema enforces >=32 chars; realtime bypasses full validation, so guard
  // here — a too-short secret weakens the session-key HMAC. Treat it as unset
  // (fail-closed) rather than deriving keys from a weak secret.
  return secret.length >= 32 ? secret : '';
}

export interface MachineSessionKeyInput {
  tenantId: string;
  driveId: string;
  pageId: string;
  secret: string;
}

// NOT renamed with the Terminal->Machine sweep: this string is HMAC input for
// every session key. Changing it re-derives every key, orphaning the warm
// Sprite behind each live machine_sessions row. Bump only for a deliberate
// key rotation.
const NAMESPACE_VERSION = 'terminal-session:v1';

export function deriveMachineSessionKey({
  tenantId,
  driveId,
  pageId,
  secret,
}: MachineSessionKeyInput): string {
  if (secret.length === 0) {
    throw new Error('deriveMachineSessionKey requires a non-empty secret');
  }
  const payload = [NAMESPACE_VERSION, tenantId, driveId, pageId].join('\0');
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-sbx-${digest}`;
}

export type MachineTeardownReason = 'idle' | 'session_end';
export type MachineLifecycleIntent = 'run' | 'end';

export interface MachineSessionRef {
  sandboxId: string;
  lastActiveAt: Date;
}

export type MachineLifecyclePlan =
  | { action: 'create' }
  | { action: 'resume'; sandboxId: string }
  | { action: 'teardown'; sandboxId: string; reason: MachineTeardownReason }
  | { action: 'noop' }
  | { action: 'deny' };

export interface PlanMachineLifecycleInput {
  canRun: boolean;
  existingSession?: MachineSessionRef | null;
  now: Date;
  idleTimeoutMs?: number;
  intent?: MachineLifecycleIntent;
  /** When true, idle sessions return noop instead of teardown — Sprites hibernates the VM. */
  persistent?: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function planMachineLifecycle({
  canRun,
  existingSession = null,
  now,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  intent = 'run',
  persistent = false,
}: PlanMachineLifecycleInput): MachineLifecyclePlan {
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

export interface MachineSessionRecord {
  sessionKey: string;
  pageId: string;
  sandboxId: string;
  userId: string;
  lastActiveAt: Date;
}

export interface MachineSessionStore {
  findBySessionKey(sessionKey: string): Promise<MachineSessionRecord | null>;
  save(input: { sessionKey: string; pageId: string; sandboxId: string; userId: string; now: Date }): Promise<void>;
  touch(args: { sessionKey: string; now: Date }): Promise<void>;
  remove(sessionKey: string): Promise<void>;
}

export interface AcquireMachineSessionInput {
  pageId: string;
  driveId: string;
  tenantId: string;
  userId: string;
  /** Caller re-checks authz every request and passes the result through to the planner. */
  canRun: boolean;
  deps: {
    store: MachineSessionStore;
    client: SandboxClient;
    now: () => Date;
    secret: string;
    /**
     * REQUIRED full-egress enablement gate, consulted when provisioning a FRESH
     * terminal. The terminal runs OPEN egress, so this gate is mandatory: if it
     * refuses, no VM is created. Required (not optional) so a caller can never
     * silently bypass containment by forgetting to wire it.
     */
    checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  };
}

export type AcquireMachineSessionResult =
  | { ok: true; sandboxId: string; sessionKey: string; resumed: boolean }
  | { ok: false; reason: 'deny' | 'provision_failed' | 'error' | FullEgressDenialReason; cause?: unknown };

async function safeStop(client: SandboxClient, sandboxId: string): Promise<boolean> {
  try {
    await client.stop({ sandboxId });
    return true;
  } catch {
    return false;
  }
}

async function safeRemove(store: MachineSessionStore, sessionKey: string): Promise<void> {
  try {
    await store.remove(sessionKey);
  } catch {
    // best-effort
  }
}

async function safeTouch(store: MachineSessionStore, sessionKey: string, now: Date): Promise<void> {
  try {
    await store.touch({ sessionKey, now });
  } catch {
    // best-effort
  }
}

// Resolved at provision time (not module load) so the configured dedicated
// egress-IP tag (`SANDBOX_EGRESS_IP_TAG`) is picked up even when set after import.
// Shared `resolveSandboxNetworkOptions` so agent + terminal share one network
// posture (open egress, same caps, same internal-surface deny). Applied on every
// hand-back (fresh + reconnect) so the open egress policy is always current.
function machineSandboxOptions(): SandboxCreateOptions {
  return resolveSandboxNetworkOptions({
    surface: 'machine',
    egressIpTag: getConfiguredEgressIpTag(),
  });
}

async function provisionFreshMachine({
  key,
  input,
}: {
  key: string;
  input: AcquireMachineSessionInput;
}): Promise<AcquireMachineSessionResult> {
  const { deps, pageId, userId, driveId } = input;

  // Full-egress containment gate (fresh provisioning only) — MANDATORY. The
  // terminal runs OPEN egress; if the gate refuses, no VM is created.
  const enablement = await deps.checkFullEgressEnablement();
  if (!enablement.ok) {
    return { ok: false, reason: enablement.reason };
  }

  const options = machineSandboxOptions();

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

  return { ok: true, sandboxId, sessionKey: key, resumed: false };
}

export async function acquireMachineSession(
  input: AcquireMachineSessionInput,
): Promise<AcquireMachineSessionResult> {
  const { deps, pageId, driveId, tenantId, userId, canRun } = input;

  // Fail closed if any namespacing component or the secret is missing.
  if (!deps.secret || !pageId || !driveId || !tenantId || !userId) {
    return { ok: false, reason: 'error' };
  }

  const key = deriveMachineSessionKey({ tenantId, driveId, pageId, secret: deps.secret });

  try {
    const existing = await deps.store.findBySessionKey(key);

    const plan = planMachineLifecycle({
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

    // Reconnect to an existing session, re-applying the open egress policy via
    // getOrCreate on every hand-back. This covers: (a) normal reconnects to warm
    // or hibernating VMs, (b) transparent re-provision if the VM has since been
    // destroyed (getOrCreate recreates it under the same name so the sandboxId
    // stays stable), (c) policy migration for sessions created before this change.
    // Shared by `resume` (within the warm window) and `noop` (persistent-idle:
    // VM is hibernating). A hibernating VM is NOT pre-warmed here: it has no
    // explicit wake API (docs.sprites.dev/concepts/lifecycle) and wakes on any
    // incoming request, so the caller's first real operation — the PTY's
    // createSession/attachSession, or an exec — is itself the wake, and carries
    // the bounded pre-open retry that a cold-start drop needs.
    const reconnectExisting = async (): Promise<AcquireMachineSessionResult> => {
      // Reconnect uses getOrCreate, which RE-PROVISIONS a vanished/reaped VM under
      // the same name — i.e. it can mint a FRESH open-egress VM. So the containment
      // gate must run here too, not only on the fresh-create path; otherwise a warm
      // or hibernating terminal would bypass containment after
      // SANDBOX_CONTAINMENT_VERIFIED is turned off.
      const enablement = await deps.checkFullEgressEnablement();
      if (!enablement.ok) {
        return { ok: false, reason: enablement.reason };
      }
      try {
        const handle = await deps.client.getOrCreate({ name: key, options: machineSandboxOptions() });
        await safeTouch(deps.store, key, deps.now());
        return { ok: true, sandboxId: handle.sandboxId, sessionKey: key, resumed: true };
      } catch (error) {
        const meta = { reason: 'provision_failed', userId, pageId, driveId };
        if (error instanceof Error) {
          loggers.api.error('Terminal sandbox reconnect failed', error, meta);
        } else {
          loggers.api.error('Terminal sandbox reconnect failed', meta);
        }
        return { ok: false, reason: 'provision_failed', cause: error };
      }
    };

    switch (plan.action) {
      case 'deny':
        return { ok: false, reason: 'deny' };

      case 'create':
        return await provisionFreshMachine({ key, input });

      case 'resume':
        return await reconnectExisting();

      case 'noop':
        // Persistent-idle: existing is guaranteed (noop only arises with a session).
        return existing
          ? await reconnectExisting()
          : { ok: false, reason: 'error' };

      case 'teardown': {
        const stopped = await safeStop(deps.client, plan.sandboxId);
        if (!stopped) {
          // VM may still be running — keep the link so the idle reaper can reclaim it.
          return { ok: false, reason: 'error' };
        }
        await safeRemove(deps.store, key);
        return await provisionFreshMachine({ key, input });
      }

      default:
        return { ok: false, reason: 'error' };
    }
  } catch (error) {
    return { ok: false, reason: 'error', cause: error };
  }
}

/**
 * Production DB-backed implementation of MachineSessionStore.
 * Lazily resolves the db client, schema table, and `eq` operator so callers
 * that inject a fake (in tests) never load the DB module graph.
 */
export async function createDbMachineSessionStore(): Promise<MachineSessionStore> {
  const [{ db }, { eq }, { machineSessions }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-sessions'),
  ]);

  return {
    async findBySessionKey(sessionKey) {
      const [row] = await db
        .select()
        .from(machineSessions)
        .where(eq(machineSessions.sessionKey, sessionKey))
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
        .insert(machineSessions)
        .values({ sessionKey, pageId, sandboxId, userId, lastActiveAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: machineSessions.sessionKey,
          set: { sandboxId, userId, lastActiveAt: now, updatedAt: now },
        });
    },

    async touch({ sessionKey, now }) {
      await db
        .update(machineSessions)
        .set({ lastActiveAt: now, updatedAt: now })
        .where(eq(machineSessions.sessionKey, sessionKey));
    },

    async remove(sessionKey) {
      await db.delete(machineSessions).where(eq(machineSessions.sessionKey, sessionKey));
    },
  };
}
