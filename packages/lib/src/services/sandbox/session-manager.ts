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
 *    always attempts the stop and always removes the link, swallowing stop
 *    errors so cleanup never throws.
 */

import { getValidatedEnv } from '../../config/env-validation';
import type { CanRunCodeResult, CanRunCodeInput, CodeExecutionDenialReason } from './can-run-code';
import type { ExecutionPolicy } from './execution-policy';
import { mapPolicyToSandboxOptions, type SandboxCreateOptions } from './sandbox-options';
import { deriveSessionKey } from './session-key';
import { planSandboxLifecycle, type TeardownReason } from './lifecycle';
import type { SandboxSessionStore } from './session-store';

/** Minimal sandbox handle the lifecycle needs; PR3's client returns the full one. */
export interface SandboxHandle {
  sandboxId: string;
}

/**
 * The slice of `@vercel/sandbox` this layer drives, injected so PR2 owns no
 * execution path. `getOrCreate` auto-resumes by `name` (the session key);
 * `get` reconnects to a known id (null if it has vanished); `stop` tears down.
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
  driveId: string;
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
  | { ok: false; reason: CodeExecutionDenialReason | 'provision_failed' };

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

// Stop a sandbox best-effort. Teardown must never throw or block — a failed stop
// is logged-and-swallowed; the platform's own timeout cap reclaims a stuck VM.
async function safeStop(client: SandboxClient, sandboxId: string): Promise<void> {
  try {
    await client.stop({ sandboxId });
  } catch {
    // Intentionally swallowed: cleanup is best-effort and must not surface.
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
  } catch {
    return { ok: false, reason: 'provision_failed' };
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
  } catch {
    // The sandbox exists but we could not record the link — tear it down so it
    // can never linger as an unreachable, unaudited orphan.
    await safeStop(deps.client, handle.sandboxId);
    return { ok: false, reason: 'provision_failed' };
  }

  return { ok: true, sandboxId: handle.sandboxId, resumed: false };
}

export async function acquireConversationSandbox(
  input: AcquireSandboxInput,
): Promise<AcquireSandboxResult> {
  const { deps, tenantId, driveId, conversationId, userId, requestOrigin, agentPageId, idleTimeoutMs } = input;

  // Fail closed if any namespacing component or the secret is missing — an empty
  // secret would make the key derivable, and an empty scope would collide.
  if (!deps.secret || !tenantId || !driveId || !conversationId || !userId) {
    return { ok: false, reason: 'error' };
  }

  const key = deriveSessionKey({ tenantId, driveId, conversationId, secret: deps.secret });
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
      return provisionFresh({ key, input });

    case 'resume': {
      const handle = await deps.client.get({ sandboxId: plan.sandboxId });
      if (!handle) {
        // The recorded sandbox is gone (platform-expired/crashed). Drop the stale
        // link and provision a fresh one under the same conversation key.
        await deps.store.remove(key);
        return provisionFresh({ key, input });
      }
      await deps.store.touch({ sessionKey: key, now: deps.now() });
      return { ok: true, sandboxId: handle.sandboxId, resumed: true };
    }

    case 'teardown': {
      // Idle-expired: reclaim the stale VM and its link, then start fresh.
      await safeStop(deps.client, plan.sandboxId);
      await deps.store.remove(key);
      return provisionFresh({ key, input });
    }

    // 'noop' only arises for an 'end' intent, which acquire never issues.
    default:
      return { ok: false, reason: 'error' };
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
 * Idempotent and never throws: the VM stop is best-effort and the link is always
 * removed, so no orphaned sandbox or dangling link survives.
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
  const existing = await deps.store.findBySessionKey(key);
  if (!existing) {
    return { torn: false };
  }

  await safeStop(deps.client, existing.sandboxId);
  await deps.store.remove(key);
  return { torn: true };
}
