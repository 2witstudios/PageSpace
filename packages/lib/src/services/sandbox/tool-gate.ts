/**
 * Call-time gate for the agent code-execution tools.
 *
 * This is the single authorization chokepoint the `bash` / `writeFile` /
 * `readFile` tools run BEFORE they touch the runner — kill-switch, then
 * `canRunCode` authz, then the advisory concurrency preflight — so a denied call
 * returns a safe tool error and never reaches provisioning. It composes the PR1
 * primitives unchanged:
 *
 *   - `isCodeExecutionEnabled` — the global env kill-switch (default OFF);
 *   - `canRunCode` — drive membership + role (and the agent's own drive access
 *     for agent-origin runs), fail-closed;
 *   - `checkCodeExecutionQuota` — the NON-reserving read of per-tier concurrency.
 *
 * It is defence in depth, not a replacement: the runner (`tool-runners.ts`)
 * still re-checks the kill-switch, reserves the concurrency slot, and
 * re-authorizes on sandbox resume (via the lifecycle). The gate's quota call is
 * advisory and non-reserving, so running it here never holds a slot — it only
 * short-circuits an obviously-denied call at the tool boundary, where the result
 * is a clean `{ ok: false }` instead of a half-provisioned run.
 *
 * Fail-closed by construction: every dependency is injected (defaults wire the
 * real implementations) and any thrown error resolves to a denial.
 */

import type { SubscriptionTier } from '../subscription-utils';
import {
  canRunCode,
  isCodeExecutionEnabled,
  type CanRunCodeInput,
  type CanRunCodeResult,
} from './can-run-code';
import { checkCodeExecutionQuota, type CodeExecutionQuotaDecision } from './quota';

export type SandboxToolGateDenialReason =
  | 'kill_switch_off'
  | 'app_admin_required'
  | 'no_drive_access'
  | 'insufficient_role'
  | 'no_agent_access'
  | 'concurrency_limit'
  | 'error';

export type SandboxToolGateResult =
  | { ok: true }
  | { ok: false; reason: SandboxToolGateDenialReason; error: string; retryAfter?: number };

/** Safe, model-facing messages. Mirrors the runner's denial copy for consistency. */
const DENIAL_MESSAGES: Record<SandboxToolGateDenialReason, string> = {
  kill_switch_off: 'Code execution is disabled.',
  app_admin_required: 'Code execution is currently limited to administrators.',
  no_drive_access: 'You do not have access to run code in this drive.',
  insufficient_role: 'Running code requires drive owner or admin access.',
  no_agent_access: 'This agent is not permitted to run code in this drive.',
  concurrency_limit: 'Too many concurrent runs. Wait for a run to finish and retry.',
  error: 'Code execution could not be authorized.',
};

const deny = (
  reason: SandboxToolGateDenialReason,
  retryAfter?: number,
): SandboxToolGateResult => ({
  ok: false,
  reason,
  error: DENIAL_MESSAGES[reason],
  ...(retryAfter ? { retryAfter } : {}),
});

/**
 * IO dependencies, injected so tests exercise the composition with fakes instead
 * of mocking the database. Defaults wire the real PR1 implementations.
 */
export interface SandboxToolGateDeps {
  isEnabled: () => boolean;
  authorize: (input: CanRunCodeInput) => Promise<CanRunCodeResult>;
  checkQuota: (input: {
    userId: string;
    driveId?: string;
    tenantId?: string;
    tier: SubscriptionTier;
  }) => Promise<CodeExecutionQuotaDecision>;
}

const defaultDeps: SandboxToolGateDeps = {
  isEnabled: isCodeExecutionEnabled,
  authorize: canRunCode,
  checkQuota: checkCodeExecutionQuota,
};

export interface SandboxToolGateInput {
  userId: string;
  driveId?: string;
  tenantId?: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  tier: SubscriptionTier;
  deps?: SandboxToolGateDeps;
}

export async function gateSandboxToolCall({
  userId,
  driveId,
  tenantId,
  requestOrigin,
  agentPageId,
  tier,
  deps = defaultDeps,
}: SandboxToolGateInput): Promise<SandboxToolGateResult> {
  try {
    // Kill-switch first: the cheapest check, and a disabled feature must deny
    // before any DB round-trip in authz or quota.
    if (!deps.isEnabled()) return deny('kill_switch_off');

    const authorization = await deps.authorize({ userId, driveId, requestOrigin, agentPageId });
    if (!authorization.ok) {
      // canRunCode's reasons are a subset of the gate's; map the kill-switch
      // value through to the gate reason and pass the authz reasons straight.
      return deny(authorization.reason);
    }

    const quota = await deps.checkQuota({ userId, driveId, tenantId, tier });
    if (!quota.allowed) return deny(quota.reason);

    return { ok: true };
  } catch {
    return deny('error');
  }
}
