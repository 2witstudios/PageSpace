import { createHmac } from 'crypto';
import type { SandboxCreateOptions } from './sandbox-options';
import { resolveSandboxNetworkOptions } from './network-options';
import { getConfiguredEgressIpTag } from './egress-ip';
import type { FullEgressEnablement, FullEgressDenialReason } from './containment';
import { loggers } from '../../logging/logger-config';

/** Minimal sandbox handle the lifecycle needs. */
export interface SandboxHandle {
  /**
   * The Sprite's NAME — our own derived session key. Deliberately NOT an
   * identity: it is reused across re-creates, so a Sprite destroyed and
   * re-provisioned under the same key answers to the same `sandboxId` while
   * being a physically different VM (see `SpriteInstanceLike.id`). Anything that
   * needs to know WHICH VM must use `spriteInstanceId`.
   */
  sandboxId: string;
  /**
   * The platform's id for this Sprite INSTANCE — the actual identity, unique per
   * VM generation. Null when the platform reported none, in which case callers
   * fall back to comparing names and accept the ABA risk that implies.
   *
   * REQUIRED, deliberately: it was optional, and an adapter
   * (`adaptMachineHandleToExecutableSandbox`) silently dropped it on the way from
   * `MachineHandle` back to `ExecutableSandbox` — which is the production session
   * client. Every `machine_sessions` row therefore stored NULL, every identity
   * guard fell back to name-only, and the whole ABA protection was inert while
   * typechecking clean. A required field makes that a compile error.
   */
  spriteInstanceId: string | null;
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

/** The only teardown reason left: idle sandboxes hibernate on the platform, they are never destroyed by this planner. */
export type MachineTeardownReason = 'session_end';
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
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function planMachineLifecycle({
  canRun,
  existingSession = null,
  now,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  intent = 'run',
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
    // Sandboxes hibernate on their own — keep the session store record alive,
    // never destroy the filesystem for mere idleness.
    return { action: 'noop' };
  }

  return { action: 'resume', sandboxId: existingSession.sandboxId };
}

export interface MachineSessionRecord {
  sessionKey: string;
  pageId: string;
  sandboxId: string;
  /** The Sprite INSTANCE this row points at — the identity `sandboxId` (a reused name) cannot express. Null on legacy rows. */
  spriteInstanceId: string | null;
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
    spriteInstanceId: string | null;
    userId: string;
    egressPolicyToken: string | null;
    now: Date;
  }): Promise<void>;
  /**
   * Advances `lastActiveAt`; also records `egressPolicyToken` when a new lockdown
   * was just confirmed, and `spriteInstanceId` when the VM behind this session
   * key CHANGED.
   *
   * That last part is load-bearing. Reconnect goes through `getOrCreate`, which
   * RE-PROVISIONS a vanished Sprite under the same name — a brand-new VM with a
   * new instance id and the SAME `sandboxId`. If the row kept the dead
   * predecessor's id, a later teardown would ask the host to kill THAT id, the
   * host would correctly decline (a different VM lives at the name now) and report
   * success, and the CAS — comparing against the stale id the row still held —
   * would MATCH and delete the row and its rescued outbox pointer. The live VM
   * would be left billing forever with nothing pointing at it: exactly the orphan
   * this whole workstream exists to kill, manufactured by its own guard.
   */
  touch(args: {
    sessionKey: string;
    now: Date;
    egressPolicyToken?: string;
    spriteInstanceId?: string | null;
  }): Promise<void>;
  remove(sessionKey: string): Promise<void>;
  /**
   * Compare-and-swap removal: deletes the row ONLY if it still points at
   * `sandboxId`. Reports whether it actually deleted.
   *
   * Use this — never plain `remove` — after killing a Sprite. `sessionKey` is
   * DETERMINISTIC per (tenant, drive, page) and `save` UPSERTS on it, so between
   * the kill and the delete a concurrent `acquireMachineSession` can provision a
   * REPLACEMENT Sprite and write it to this very row. A key-only delete would
   * then destroy the pointer to that brand-new, LIVE Sprite, leaving it billing
   * forever with nothing — not even the orphan reconciler — able to find it.
   */
  removeIfSandbox(input: { sessionKey: string; sandboxId: string; spriteInstanceId: string | null }): Promise<boolean>;
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

async function safeRemoveIfSandbox(
  store: MachineSessionStore,
  input: { sessionKey: string; sandboxId: string; spriteInstanceId: string | null },
): Promise<void> {
  try {
    await store.removeIfSandbox(input);
  } catch {
    // best-effort
  }
}

async function safeTouch(
  store: MachineSessionStore,
  sessionKey: string,
  now: Date,
  egressPolicyToken?: string,
  spriteInstanceId?: string | null,
): Promise<void> {
  try {
    await store.touch({ sessionKey, now, egressPolicyToken, spriteInstanceId });
  } catch {
    // Best-effort. A lost token write only costs a redundant re-apply on the next
    // hand-back (the record stays stale → `shouldApplyPolicy` says yes), never an
    // unlocked Sprite. A lost INSTANCE write leaves the row naming a dead VM while
    // a live one holds the name — which is why a kill against a stale id refuses
    // rather than reporting success (`MachineSpriteReplacedError`): the pointer is
    // kept, the staleness surfaces as a retry, and the next connect re-writes it.
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
  let spriteInstanceId: string | null = null;
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
    spriteInstanceId = handle.spriteInstanceId ?? null;
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
      // WHICH VM this is, as opposed to which name it answers to. Every teardown
      // CAS keys on this, so a Sprite re-provisioned under the same name can never
      // be mistaken for its predecessor.
      spriteInstanceId,
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

    // Sprites hibernate when idle and wake on demand, so an idle terminal VM is
    // always resumed, never destroyed — the planner returns `noop` on idle
    // (handled below as a reconnect), and can never express idle teardown.
    const plan = planMachineLifecycle({
      canRun,
      existingSession: existing
        ? { sandboxId: existing.sandboxId, lastActiveAt: existing.lastActiveAt }
        : null,
      now: deps.now(),
      intent: 'run',
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
        // `getOrCreate` RE-PROVISIONS a vanished Sprite under the same name, so a
        // "reconnect" can hand back a brand-new VM: same `sandboxId`, different
        // INSTANCE. Record the new identity whenever it moved — the row is the
        // pointer, and a pointer naming a dead predecessor is the setup for
        // destroying (or stranding) the live VM standing in its place. The token
        // write below already exists for exactly this reason: it is derived from
        // the sprite's instance id, so it moves precisely when the VM does.
        const movedInstance =
          handle.spriteInstanceId != null && handle.spriteInstanceId !== existing?.spriteInstanceId
            ? handle.spriteInstanceId
            : undefined;
        await safeTouch(
          deps.store,
          key,
          deps.now(),
          confirmed && confirmed !== appliedEgressToken ? confirmed : undefined,
          movedInstance,
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
      case 'noop':
        // 'resume' (warm) and 'noop' (hibernating-idle) both reconnect; `existing`
        // is guaranteed for both — the planner only returns either action when
        // an existing session was passed in.
        return existing
          ? await reconnectExisting()
          : { ok: false, reason: 'error' };

      case 'teardown': {
        const stopped = await safeStop(deps.client, plan.sandboxId);
        if (!stopped) {
          // VM may still be running — keep the link so a later attempt (or the
          // orphan-reconcile cron) can still find it and finish the teardown.
          return { ok: false, reason: 'error' };
        }
        // CAS on the INSTANCE we just stopped, never a key-only delete: this
        // immediately re-provisions under the SAME session key below, and a name is
        // reused across re-creates — so a key-keyed remove could delete the row that
        // the re-provision (or a concurrent acquire) has already pointed at a NEW,
        // live VM, orphaning it with no pointer at all. Losing the CAS is correct:
        // whoever owns the row now owns a live Sprite, and the one we stopped is
        // already gone.
        await safeRemoveIfSandbox(deps.store, {
          sessionKey: key,
          sandboxId: plan.sandboxId,
          spriteInstanceId: existing?.spriteInstanceId ?? null,
        });
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
 * Read-only: the `sandboxId` of a page's LIVE machine_session, or `null` if
 * it has none yet. Unlike `acquireMachineSession`, this never re-authorizes,
 * provisions, or touches a Sprite. For callers that only need to know WHERE
 * (if anywhere) a page's Sprite already lives — e.g. propagating state from
 * the root Machine's Sprite into some other Sprite (`machine-branches.ts`'s
 * `propagateClaudeCredential`, and the realtime branch-scope PTY resolution
 * that also refreshes it) — never to acquire or resume one themselves.
 *
 * Resolves the CURRENT session key (`deriveMachineSessionKey`) and queries by
 * it — the table's own unique constraint — rather than a bare `pageId`
 * (caught in review, P1): `sessionKey` namespaces by tenant + drive + page, so
 * a page moved between drives can leave its OLD drive's session row behind
 * (a drive move has no reason to touch `machine_sessions`, and the old row
 * only disappears once that session tears down on its own). A bare-`pageId`
 * lookup with no ordering could then non-deterministically return that STALE
 * row — whose Sprite may belong to a different owner/tenant context entirely
 * — and hand back state (here, a Claude Code credential) that was never that
 * page's current owner's to give out. Deriving the exact expected key first
 * makes the lookup exact by construction: it resolves the CURRENT session or
 * nothing, never a stale one from a prior drive.
 *
 * Lazily resolves the db client, schema table, and `eq` operator so callers
 * that don't exercise this path (most tests) never load the DB module graph.
 */
export async function findLiveMachineSandboxId(input: MachineSessionKeyInput): Promise<string | null> {
  const sessionKey = deriveMachineSessionKey(input);
  const [{ db }, { eq }, { machineSessions }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-sessions'),
  ]);
  const [row] = await db
    .select({ sandboxId: machineSessions.sandboxId })
    .from(machineSessions)
    .where(eq(machineSessions.sessionKey, sessionKey))
    .limit(1);
  return row?.sandboxId ?? null;
}

/**
 * Production DB-backed implementation of MachineSessionStore.
 * Lazily resolves the db client, schema table, and operators so callers
 * that inject a fake (in tests) never load the DB module graph.
 */
export async function createDbMachineSessionStore(): Promise<MachineSessionStore> {
  const [{ db }, { eq, and, eqOrIsNull }, { machineSessions }, { machineSpriteReclaims }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-sessions'),
    import('@pagespace/db/schema/machine-sprite-reclaims'),
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
        spriteInstanceId: row.spriteInstanceId,
        userId: row.userId,
        lastActiveAt: row.lastActiveAt,
        egressPolicyToken: row.egressPolicyToken,
      };
    },

    async save({ sessionKey, pageId, sandboxId, spriteInstanceId, userId, egressPolicyToken, now }) {
      await db
        .insert(machineSessions)
        .values({
          sessionKey,
          pageId,
          sandboxId,
          spriteInstanceId,
          userId,
          egressPolicyToken,
          lastActiveAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: machineSessions.sessionKey,
          set: {
            sandboxId,
            spriteInstanceId,
            userId,
            egressPolicyToken,
            lastActiveAt: now,
            updatedAt: now,
            // This row now points at a LIVE Sprite, so any teardown INTENT recorded
            // against its predecessor is void. Leaving it set would let the orphan
            // reconciler destroy this live VM later — and worse, would turn a future
            // REVERSIBLE trash of the restored Machine into an irreversible kill.
            teardownRequestedAt: null,
          },
        });
    },

    async touch({ sessionKey, now, egressPolicyToken, spriteInstanceId }) {
      await db
        .update(machineSessions)
        .set({
          lastActiveAt: now,
          updatedAt: now,
          // Only overwrite the recorded token when a new lockdown was just
          // confirmed — an omitted token must not blank the existing record.
          ...(egressPolicyToken === undefined ? {} : { egressPolicyToken }),
          // Likewise, only when the VM behind this key actually CHANGED (a
          // re-provision). Recording it also voids any teardown INTENT: that
          // request was against the previous VM, which is provably gone, and
          // leaving it set would let the reconciler destroy this live one.
          //
          // A changed instance id is a NEW VM with a FRESH disk, so the stored
          // measurement — which describes the previous generation's filesystem
          // — is dropped rather than inherited. Keeping it would bill the old
          // size until some unrelated wake happened to re-measure. Unlike the
          // branch/project tiers there is no watermark to reset: `machine_sessions`
          // rows carry no `spriteTornDownAt` and are never excluded from the
          // reconcile, so no billing window is ever skipped for them.
          ...(spriteInstanceId === undefined
            ? {}
            : { spriteInstanceId, teardownRequestedAt: null, storageMeasuredBytes: null, storageMeasuredAt: null }),
        })
        .where(eq(machineSessions.sessionKey, sessionKey));
    },

    async remove(sessionKey) {
      await db.delete(machineSessions).where(eq(machineSessions.sessionKey, sessionKey));
    },

    async removeIfSandbox({ sessionKey, sandboxId, spriteInstanceId }) {
      // One transaction, because the AFTER DELETE trigger will rescue this row's
      // sandboxId into the reclaim outbox as we delete it (it cannot know WHY the
      // row is going). Here we know: the Sprite was already CONFIRMED dead, so the
      // rescued pointer is not needed and would only cost a redundant kill on the
      // next cron tick. Deleting both together keeps that self-cleaning — and if
      // this transaction rolls back, the pointer survives, which is the safe way
      // to be wrong.
      return db.transaction(async (tx) => {
        // CAS on the INSTANCE where we know it (`sandboxId` is a reused name, so it
        // cannot tell a replacement VM from the one we killed — comparing it alone
        // would let us delete the pointer to a live re-provisioned Sprite).
        const deleted = await tx
          .delete(machineSessions)
          .where(
            and(
              eq(machineSessions.sessionKey, sessionKey),
              eq(machineSessions.sandboxId, sandboxId),
              eqOrIsNull(machineSessions.spriteInstanceId, spriteInstanceId),
            ),
          )
          .returning({ id: machineSessions.id });
        if (deleted.length === 0) return false;
        await tx.delete(machineSpriteReclaims).where(eq(machineSpriteReclaims.sandboxId, sandboxId));
        return true;
      });
    },
  };
}
