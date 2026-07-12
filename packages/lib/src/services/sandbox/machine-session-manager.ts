import { createHmac } from 'crypto';
import type { SandboxCreateOptions } from './sandbox-options';
import { resolveSandboxNetworkOptions } from './network-options';
import { getConfiguredEgressIpTag } from './egress-ip';
import type { FullEgressEnablement, FullEgressDenialReason } from './containment';
import { loggers } from '../../logging/logger-config';

/** Minimal sandbox handle the lifecycle needs. */
export interface SandboxHandle {
  sandboxId: string;
  /**
   * Proof that this VM is running the egress policy the caller asked for — a
   * token over (Sprite instance id, policy hash); see `egress-lockdown.ts`. The
   * driver returns it once the lockdown is confirmed; the caller persists it and
   * hands it back as `appliedEgressToken` on the next connect, which is what lets
   * a warm resume skip the redundant policy push. Undefined = unproven (the `get`
   * path, or a platform that did not report the Sprite's identity) → record
   * nothing, and the next hand-back re-applies.
   */
  egressPolicyToken?: string;
}

export interface SandboxGetOrCreateArgs {
  name: string;
  options: SandboxCreateOptions;
  /**
   * The lockdown token persisted for this session — proof that a specific policy
   * was applied to a specific Sprite INSTANCE (see `egress-lockdown.ts`). The
   * driver re-applies the policy unless this still holds: absent (unknown → fail
   * closed), a changed policy, or a Sprite re-created under the same name (a new
   * VM, on the platform's default open egress, whose predecessor's proof must not
   * carry over). Otherwise it skips the control-plane round-trip, because the
   * policy file is persistent and survives hibernation.
   */
  appliedEgressToken?: string | null;
}

/**
 * The provider-agnostic slice of the sandbox client this layer drives, injected
 * so this lifecycle owns no execution path (the Fly Sprites driver implements
 * it). `getOrCreate` auto-resumes by `name` (the session key); `get` reconnects
 * to a known id (null if it has vanished); `stop` DESTROYS — see its own doc.
 */
export interface SandboxClient {
  getOrCreate(args: SandboxGetOrCreateArgs): Promise<SandboxHandle>;
  get(args: { sandboxId: string }): Promise<SandboxHandle | null>;
  /**
   * Irreversible DESTROY — files, installed packages, and checkpoints are gone,
   * with no undo (docs.sprites.dev/working-with-sprites). Call this ONLY for
   * genuine teardown intent (a Machine/branch delete, or cleaning up a Sprite
   * this process just failed to link to a session row) — NEVER as idle/billing
   * cleanup. A paused sandbox already stops compute billing on its own and costs
   * only bytes-written storage, so idleness alone is never a reason to call this.
   */
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
  /**
   * The lockdown token last confirmed for this session — proof that a specific
   * policy was applied to a specific Sprite INSTANCE (see `egress-lockdown.ts`).
   * Null when unknown: a session that predates the record, a lost write, or a
   * platform that did not report the Sprite's identity. Null makes the next
   * hand-back re-apply the lockdown — fail closed.
   */
  egressPolicyToken: string | null;
}

export interface MachineSessionStore {
  findBySessionKey(sessionKey: string): Promise<MachineSessionRecord | null>;
  save(input: {
    sessionKey: string;
    pageId: string;
    sandboxId: string;
    userId: string;
    egressPolicyToken: string | null;
    now: Date;
  }): Promise<void>;
  /** Advances `lastActiveAt`; also records `egressPolicyToken` when a new lockdown was just confirmed. */
  touch(args: { sessionKey: string; now: Date; egressPolicyToken?: string }): Promise<void>;
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

async function safeTouch(
  store: MachineSessionStore,
  sessionKey: string,
  now: Date,
  egressPolicyToken?: string,
): Promise<void> {
  try {
    await store.touch({ sessionKey, now, egressPolicyToken });
  } catch {
    // Best-effort. A lost token write only costs a redundant re-apply on the next
    // hand-back (the record stays stale → `shouldApplyPolicy` says yes), never an
    // unlocked Sprite.
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
  let egressPolicyToken: string | undefined;
  try {
    // No `appliedEgressToken`: there is no session row, so nothing is known about
    // this name's egress state. The driver locks it down (fresh create, or a
    // resume of an orphaned Sprite whose policy we cannot vouch for) and rejects
    // if it cannot — so the session below is only ever linked to a VM whose
    // policy is confirmed. That ordering, not re-application, is what keeps a
    // crash between `createSprite` and lockdown from ever being handed back.
    const handle = await deps.client.getOrCreate({ name: key, options });
    sandboxId = handle.sandboxId;
    egressPolicyToken = handle.egressPolicyToken;
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
    await deps.store.save({
      sessionKey: key,
      pageId,
      userId,
      sandboxId,
      // What the driver CONFIRMED for this VM, not what we asked for. Null when it
      // could not prove it (no Sprite identity) → the next hand-back re-applies.
      egressPolicyToken: egressPolicyToken ?? null,
      now: deps.now(),
    });
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

    // Reconnect to an existing session via getOrCreate. This covers: (a) normal
    // reconnects to warm or hibernating VMs, (b) transparent re-provision if the
    // VM has since been destroyed (getOrCreate recreates it under the same name
    // so the sandboxId stays stable), (c) policy migration — a changed policy is
    // detected by hash and pushed once, then recorded.
    //
    // The policy is NOT re-pushed when the recorded hash already matches: it is a
    // persistent file on the Sprite that survives hibernation, so re-applying it
    // on every hand-back (including each 60s re-auth tick) was a control-plane
    // round-trip plus a `mkdir` exec bought for nothing on the connect path.
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
      const options = machineSandboxOptions();
      const appliedEgressToken = existing?.egressPolicyToken ?? null;
      try {
        const handle = await deps.client.getOrCreate({ name: key, options, appliedEgressToken });
        // getOrCreate resolved, so this VM is confirmed to be running the policy
        // its token names — record it when it MOVED (a new Sprite instance, or a
        // changed policy). An unchanged token is already on the row, so writing it
        // again would be a pointless UPDATE on every connect.
        const confirmed = handle.egressPolicyToken;
        await safeTouch(
          deps.store,
          key,
          deps.now(),
          confirmed && confirmed !== appliedEgressToken ? confirmed : undefined,
        );
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
          // VM may still be running — keep the link so a later attempt (or an
          // explicit retry) can still find it and finish the teardown. There is
          // no separate reaper; nothing reclaims this but a future call here.
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
        egressPolicyToken: row.egressPolicyToken,
      };
    },

    async save({ sessionKey, pageId, sandboxId, userId, egressPolicyToken, now }) {
      await db
        .insert(machineSessions)
        .values({ sessionKey, pageId, sandboxId, userId, egressPolicyToken, lastActiveAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: machineSessions.sessionKey,
          set: { sandboxId, userId, egressPolicyToken, lastActiveAt: now, updatedAt: now },
        });
    },

    async touch({ sessionKey, now, egressPolicyToken }) {
      await db
        .update(machineSessions)
        .set({
          lastActiveAt: now,
          updatedAt: now,
          // Only overwrite the recorded token when a new lockdown was just
          // confirmed — an omitted token must not blank the existing record.
          ...(egressPolicyToken === undefined ? {} : { egressPolicyToken }),
        })
        .where(eq(machineSessions.sessionKey, sessionKey));
    },

    async remove(sessionKey) {
      await db.delete(machineSessions).where(eq(machineSessions.sessionKey, sessionKey));
    },
  };
}
