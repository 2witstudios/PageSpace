/**
 * Machine sandbox lifecycle (IO, dependency-injected).
 *
 * A Machine's Sprite is addressed by an opaque HMAC session key derived from
 * its identity (see machine-identity.ts) — this module resolves that key to a
 * live sandbox, provisioning one on first use and reconnecting (never
 * destroying) on every later call, exactly like a Terminal page's sandbox:
 * the whole point of a Machine is that its filesystem — and therefore its
 * cloned Projects — survives idle periods. The state machine is shared
 * verbatim with terminal-session-manager.ts (`planTerminalLifecycle`,
 * `persistent: true`) rather than re-implemented here.
 *
 * All IO — the sandbox client, the session store, the clock, the egress
 * enablement gate, the key secret — is injected, so the orchestration is unit
 * tested with fakes and never touches the real sandbox driver or the
 * database.
 */

import { createHmac } from 'crypto';
import type { SandboxCreateOptions } from '../sandbox/sandbox-options';
import { resolveSandboxNetworkOptions } from '../sandbox/network-options';
import { getConfiguredEgressIpTag } from '../sandbox/egress-ip';
import type { FullEgressEnablement, FullEgressDenialReason } from '../sandbox/containment';
import type { SandboxClient } from '../sandbox/session-manager';
import { planTerminalLifecycle } from '../sandbox/terminal-session-manager';
import { loggers } from '../../logging/logger-config';

export interface MachineSessionKeyInput {
  tenantId: string;
  machineKey: string;
  secret: string;
}

const NAMESPACE_VERSION = 'machine-session:v1';

export function deriveMachineSessionKey({ tenantId, machineKey, secret }: MachineSessionKeyInput): string {
  if (secret.length === 0) {
    throw new Error('deriveMachineSessionKey requires a non-empty secret');
  }
  const payload = [NAMESPACE_VERSION, tenantId, machineKey].join('\0');
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-sbx-${digest}`;
}

export interface MachineSessionRef {
  sandboxId: string;
  lastActiveAt: Date;
}

export interface MachineSessionRecord {
  sessionKey: string;
  sandboxId: string;
  ownerId: string;
  lastActiveAt: Date;
}

export interface MachineSessionStore {
  findBySessionKey(sessionKey: string): Promise<MachineSessionRecord | null>;
  save(input: { sessionKey: string; ownerId: string; sandboxId: string; now: Date }): Promise<void>;
  touch(args: { sessionKey: string; now: Date }): Promise<void>;
  remove(sessionKey: string): Promise<void>;
}

export interface AcquireMachineSandboxInput {
  machineKey: string;
  tenantId: string;
  ownerId: string;
  /** Caller re-checks authz every request and passes the result through to the planner. */
  canRun: boolean;
  deps: {
    store: MachineSessionStore;
    client: SandboxClient;
    now: () => Date;
    secret: string;
    /** REQUIRED full-egress enablement gate — a Machine runs OPEN egress, same as a Terminal page. */
    checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  };
}

export type AcquireMachineSandboxResult =
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

// Machines share the Terminal surface (open egress, hibernate-not-destroy) —
// resolved at acquisition time so a configured dedicated egress-IP tag is
// picked up even when set after import.
function machineSandboxOptions(): SandboxCreateOptions {
  return resolveSandboxNetworkOptions({
    surface: 'terminal',
    egressIpTag: getConfiguredEgressIpTag(),
  });
}

async function provisionFreshMachine({
  key,
  input,
}: {
  key: string;
  input: AcquireMachineSandboxInput;
}): Promise<AcquireMachineSandboxResult> {
  const { deps, machineKey, ownerId } = input;

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
    const meta = { reason: 'provision_failed', ownerId, machineKey };
    if (error instanceof Error) {
      loggers.api.error('Machine sandbox acquisition failed', error, meta);
    } else {
      loggers.api.error('Machine sandbox acquisition failed', meta);
    }
    return { ok: false, reason: 'provision_failed', cause: error };
  }

  try {
    await deps.store.save({ sessionKey: key, ownerId, sandboxId, now: deps.now() });
  } catch (error) {
    // The sandbox exists but we could not record the link — tear it down to
    // prevent an unreachable, unaudited orphan.
    await safeStop(deps.client, sandboxId);
    return { ok: false, reason: 'provision_failed', cause: error };
  }

  return { ok: true, sandboxId, sessionKey: key, resumed: false };
}

export async function acquireMachineSandbox(
  input: AcquireMachineSandboxInput,
): Promise<AcquireMachineSandboxResult> {
  const { deps, machineKey, tenantId, ownerId, canRun } = input;

  if (!deps.secret || !machineKey || !tenantId || !ownerId) {
    return { ok: false, reason: 'error' };
  }

  const key = deriveMachineSessionKey({ tenantId, machineKey, secret: deps.secret });

  try {
    const existing = await deps.store.findBySessionKey(key);

    const plan = planTerminalLifecycle({
      canRun,
      existingSession: existing
        ? { sandboxId: existing.sandboxId, lastActiveAt: existing.lastActiveAt }
        : null,
      now: deps.now(),
      intent: 'run',
      // Sprites hibernate when idle and wake on demand — a Machine's whole
      // value is a persistent filesystem, so an idle Machine is reconnected,
      // never destroyed.
      persistent: true,
    });

    const reconnectExisting = async (): Promise<AcquireMachineSandboxResult> => {
      // getOrCreate can re-provision a vanished/reaped VM under the same name
      // (a fresh open-egress VM), so the containment gate must run on every
      // hand-back, not only on first create.
      const enablement = await deps.checkFullEgressEnablement();
      if (!enablement.ok) {
        return { ok: false, reason: enablement.reason };
      }
      try {
        const handle = await deps.client.getOrCreate({ name: key, options: machineSandboxOptions() });
        await safeTouch(deps.store, key, deps.now());
        return { ok: true, sandboxId: handle.sandboxId, sessionKey: key, resumed: true };
      } catch (error) {
        const meta = { reason: 'provision_failed', ownerId, machineKey };
        if (error instanceof Error) {
          loggers.api.error('Machine sandbox reconnect failed', error, meta);
        } else {
          loggers.api.error('Machine sandbox reconnect failed', meta);
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
        return existing
          ? await reconnectExisting()
          : { ok: false, reason: 'error' };

      case 'teardown': {
        const stopped = await safeStop(deps.client, plan.sandboxId);
        if (!stopped) {
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
        sandboxId: row.sandboxId,
        ownerId: row.ownerId,
        lastActiveAt: row.lastActiveAt,
      };
    },

    async save({ sessionKey, ownerId, sandboxId, now }) {
      await db
        .insert(machineSessions)
        .values({ sessionKey, ownerId, sandboxId, lastActiveAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: machineSessions.sessionKey,
          set: { sandboxId, ownerId, lastActiveAt: now, updatedAt: now },
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
