/**
 * Conversation sandbox lifecycle effects (IO, dependency-injected).
 *
 * Ties the pure pieces together against real IO: derive the session key, look up
 * the stored link, RE-AUTHORIZE the current actor, plan, then execute the plan
 * (create / resume / idle-teardown) against the injected sandbox client and
 * session store. All IO — the sandbox client, the store, the clock, the authz
 * call, and the key secret — is injected, so the orchestration is tested with
 * fakes (no DB, no real sandbox).
 *
 * Security invariants enforced here:
 *  - **Resume re-authz**: `authorize` runs for the CURRENT actor every turn; a
 *    denial returns no handle, and the warm sandbox is never reconnected.
 *  - **Guaranteed teardown / no orphans**: if the link cannot be persisted after
 *    a create, the just-created sandbox is stopped; `teardownConversationSandbox`
 *    guards its lookup and runs the VM stop best-effort, removing the link only
 *    after a CONFIRMED stop — an unconfirmed stop keeps the link so the VM is
 *    reclaimable (by retry / the idle reaper) instead of orphaned.
 */

import { getValidatedEnv } from '../../config/env-validation';
import { loggers } from '../../logging/logger-config';
import type { CanRunCodeResult, CanRunCodeInput, CodeExecutionDenialReason } from './can-run-code';
import type { ExecutionPolicy } from './execution-policy';
import { mapPolicyToSandboxOptions, type SandboxCreateOptions } from './sandbox-options';
import { deriveSessionKey } from './session-key';
import { planSandboxLifecycle, type TeardownReason } from './lifecycle';
import type { SandboxSessionStore, SandboxSessionRecord } from './session-store';

/** Minimal sandbox handle the lifecycle needs; PR3's client returns the full one. */
export interface SandboxHandle {
  sandboxId: string;
}

/**
 * The provider-agnostic slice of the sandbox client this layer drives, injected
 * so this lifecycle owns no execution path (the PR3 Fly Sprites driver
 * implements it). `getOrCreate` auto-resumes by `name` (the session key); `get`
 * reconnects to a known id (null if it has vanished); `stop` tears down.
 */
export interface SandboxClient {
  getOrCreate(args: { name: string; options: SandboxCreateOptions }): Promise<SandboxHandle>;
  get(args: { sandboxId: string }): Promise<SandboxHandle | null>;
  stop(args: { sandboxId: string }): Promise<void>;
}

export interface AcquireSandboxDeps {
  store: SandboxSessionStore;
  client: SandboxClient;
  /** Re-authorize the CURRENT actor. Fail-closed; must never throw (canRunCode). */
  authorize: (input: CanRunCodeInput) => Promise<CanRunCodeResult>;
  now: () => Date;
  /** Server-held secret for session-key derivation. */
  secret: string;
}

export interface AcquireSandboxInput {
  tenantId: string;
  /** Absent for global (non-drive) contexts. Session key uses '' for the drive
   *  segment when driveId is not provided. */
  driveId?: string;
  conversationId: string;
  userId: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  policy?: ExecutionPolicy;
  idleTimeoutMs?: number;
  deps: AcquireSandboxDeps;
}

export type AcquireSandboxResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | { ok: false; reason: CodeExecutionDenialReason | 'provision_failed'; cause?: unknown };

/**
 * Read the session-key secret from validated env. Returns '' (→ fail-closed deny
 * in the lifecycle effects) when unset or when validation fails, so a missing
 * secret disables sandbox acquisition rather than throwing at the call site.
 */
export function getSandboxSessionSecret(): string {
  try {
    return getValidatedEnv().SANDBOX_SESSION_SECRET ?? '';
  } catch {
    return '';
  }
}

// Stop a sandbox best-effort, reporting whether the stop was CONFIRMED. Never
// throws or blocks: a failed stop is swallowed and reported as `false` so the
// caller can decide whether it is safe to drop the session link (only after a
// confirmed stop) or must keep it for a retry / the idle reaper — deleting the
// link for a VM that may still be alive would orphan it.
async function safeStop(client: SandboxClient, sandboxId: string): Promise<boolean> {
  try {
    await client.stop({ sandboxId });
    return true;
  } catch {
    // Intentionally swallowed: cleanup is best-effort and must not surface.
    return false;
  }
}

// Remove the link best-effort during teardown: a failed delete must not surface
// from cleanup. A lingering row is self-correcting — the next acquire reconnects
// to a stopped VM (get → null) and upserts a fresh sandbox under the same key.
async function safeRemove(store: SandboxSessionStore, sessionKey: string): Promise<void> {
  try {
    await store.remove(sessionKey);
  } catch {
    // Intentionally swallowed: cleanup is best-effort and must not surface.
  }
}

// Update lastActiveAt best-effort: a failed metadata write must not deny an
// already-authorized, confirmed-live resume — the worst case is an earlier idle
// reclaim, never a lost session for the legitimate actor.
async function safeTouch(store: SandboxSessionStore, sessionKey: string, now: Date): Promise<void> {
  try {
    await store.touch({ sessionKey, now });
  } catch {
    // Intentionally swallowed.
  }
}

async function provisionFresh({
  key,
  input,
}: {
  key: string;
  input: AcquireSandboxInput;
}): Promise<AcquireSandboxResult> {
  const { deps, policy, tenantId, driveId, conversationId, userId } = input;
  const options = mapPolicyToSandboxOptions({ policy });

  let handle: SandboxHandle;
  try {
    handle = await deps.client.getOrCreate({ name: key, options });
  } catch (error) {
    const meta = { reason: 'provision_failed', userId, conversationId, driveId };
    if (error instanceof Error) {
      loggers.ai.error('Sandbox acquisition failed', error, meta);
    } else {
      loggers.ai.error('Sandbox acquisition failed', meta);
    }
    return { ok: false, reason: 'provision_failed', cause: error };
  }

  try {
    await deps.store.save({
      sessionKey: key,
      conversationId,
      driveId,
      tenantId,
      userId,
      sandboxId: handle.sandboxId,
      now: deps.now(),
    });
  } catch (error) {
    // The sandbox exists but we could not record the link — tear it down so it
    // can never linger as an unreachable, unaudited orphan.
    await safeStop(deps.client, handle.sandboxId);
    return { ok: false, reason: 'provision_failed', cause: error };
  }

  return { ok: true, sandboxId: handle.sandboxId, resumed: false };
}

export async function acquireConversationSandbox(
  input: AcquireSandboxInput,
): Promise<AcquireSandboxResult> {
  const { deps, tenantId, driveId, conversationId, userId, requestOrigin, agentPageId, idleTimeoutMs } = input;

  // Fail closed if any required namespacing component or the secret is missing.
  // driveId is intentionally optional (absent for global context) — its absence is
  // handled by deriveSessionKey which substitutes '' for the drive segment.
  if (!deps.secret || !tenantId || !conversationId || !userId) {
    return { ok: false, reason: 'error' };
  }

  const key = deriveSessionKey({ tenantId, driveId, conversationId, secret: deps.secret });

  // Fail closed on any unexpected IO error (store lookup/remove, client.get): a
  // failure here means we cannot establish session state safely, so we deny
  // rather than risk provisioning or leaking a handle.
  try {
    const existing = await deps.store.findBySessionKey(key);
    const authorization = await deps.authorize({ userId, driveId, requestOrigin, agentPageId });

    const plan = planSandboxLifecycle({
      authorization,
      existingSession: existing
        ? { sandboxId: existing.sandboxId, lastActiveAt: existing.lastActiveAt }
        : null,
      now: deps.now(),
      idleTimeoutMs,
      intent: 'run',
    });

    switch (plan.action) {
      case 'deny':
        return { ok: false, reason: plan.reason };

      case 'create':
        return await provisionFresh({ key, input });

      case 'resume': {
        const handle = await deps.client.get({ sandboxId: plan.sandboxId });
        if (!handle) {
          // The recorded sandbox is gone (platform-expired/crashed). Drop the stale
          // link and provision a fresh one under the same conversation key.
          await deps.store.remove(key);
          return await provisionFresh({ key, input });
        }
        await safeTouch(deps.store, key, deps.now());
        return { ok: true, sandboxId: handle.sandboxId, resumed: true };
      }

      case 'teardown': {
        // Idle-expired: reclaim the stale VM and its link, then start fresh.
        await safeStop(deps.client, plan.sandboxId);
        await deps.store.remove(key);
        return await provisionFresh({ key, input });
      }

      // 'noop' only arises for an 'end' intent, which acquire never issues.
      default:
        return { ok: false, reason: 'error' };
    }
  } catch (error) {
    return { ok: false, reason: 'error', cause: error };
  }
}

export interface TeardownSandboxDeps {
  store: SandboxSessionStore;
  client: SandboxClient;
  secret: string;
}

export interface TeardownSandboxInput {
  tenantId: string;
  driveId: string;
  conversationId: string;
  reason: TeardownReason;
  deps: TeardownSandboxDeps;
}

/**
 * Tear down a conversation's sandbox on session end / idle / crash / failure.
 * Idempotent and never throws: the lookup is guarded and the VM stop + link
 * removal are best-effort. The link is removed ONLY after a CONFIRMED stop — an
 * unconfirmed stop (the VM may still be alive) keeps the link and reports
 * `torn: false`, so a later teardown or the idle reaper can reclaim the VM rather
 * than orphaning it with no DB record. A lingering link after a *confirmed* stop
 * but failed removal is self-correcting (the next acquire reconnects to a stopped
 * VM → null and re-provisions under the same key).
 */
export async function teardownConversationSandbox({
  tenantId,
  driveId,
  conversationId,
  deps,
}: TeardownSandboxInput): Promise<{ torn: boolean }> {
  if (!deps.secret || !tenantId || !driveId || !conversationId) {
    return { torn: false };
  }

  const key = deriveSessionKey({ tenantId, driveId, conversationId, secret: deps.secret });

  // The lookup is the only throwing IO before we know there is anything to tear
  // down. If the store is unavailable we cannot proceed, but cleanup must never
  // propagate — report not-torn rather than throwing out of an end/crash path.
  let existing: SandboxSessionRecord | null;
  try {
    existing = await deps.store.findBySessionKey(key);
  } catch {
    return { torn: false };
  }
  if (!existing) {
    return { torn: false };
  }

  const stopped = await safeStop(deps.client, existing.sandboxId);
  if (!stopped) {
    // Unconfirmed stop: the VM may still be running. Keep the link so a retry or
    // the idle reaper can reclaim it; deleting it now would orphan a live VM.
    return { torn: false };
  }
  await safeRemove(deps.store, key);
  return { torn: true };
}
