/**
 * Agent machine-session acquisition (IO, dependency-injected).
 *
 * Resolves the ACTIVE machine for an agent tool call onto a persistent,
 * page-keyed Sprite session — the same lifecycle a human Terminal page uses
 * (`terminal-session-manager.ts`) — instead of a throwaway per-conversation
 * one (the old `session-manager.ts`, deleted). `{ kind: 'existing', terminalId }`
 * addresses that Terminal page's machine directly; `{ kind: 'own' }` (the
 * default when unset) addresses the agent's OWN page as its dedicated
 * machine — lazily provisioned on first use, and reconnected (same sandboxId,
 * same filesystem) on every later call.
 *
 * Re-authorizes the CURRENT actor via the injected `authorize` (canRunCode) on
 * every call, mirroring the resume-re-authz invariant the old conversation-keyed
 * acquisition enforced: a permission change since the last call must deny
 * before a warm sandbox is ever handed back.
 */

import type { CanRunCodeInput, CanRunCodeResult, CodeExecutionDenialReason } from './can-run-code';
import type { FullEgressEnablement, FullEgressDenialReason } from './containment';
import { acquireTerminalSandbox, type SandboxClient, type TerminalSessionStore } from './terminal-session-manager';
import type { MachineRuntimeGuardrailDecision } from './quota';

/**
 * Structural mirror of the canonical `MachineRef`
 * (apps/web/src/lib/repositories/page-agent-repository.ts). packages/lib never
 * imports from apps/web, so this is a duck-typed copy of the same two-variant
 * shape — any value satisfying the web type satisfies this one too.
 */
export type MachineRefLike = { kind: 'own' } | { kind: 'existing'; terminalId: string };

/**
 * Resolves which page identifies the ACTIVE machine's persistent session:
 * 'existing' machines are addressed by their Terminal page id directly; 'own'
 * (the default when `activeMachine` is unset) is addressed by the AGENT'S OWN
 * page id — the agent page IS the machine identity. Returns undefined when
 * neither is available (e.g. the global assistant, which has no backing page
 * yet — see tasks/terminal.md's "global-assistant parallel" follow-on).
 */
export function resolveMachinePageId(input: {
  agentPageId?: string;
  activeMachine?: MachineRefLike;
}): string | undefined {
  const machine = input.activeMachine ?? { kind: 'own' as const };
  return machine.kind === 'existing' ? machine.terminalId : input.agentPageId;
}

export interface AcquireMachineSandboxDeps {
  store: TerminalSessionStore;
  client: SandboxClient;
  /** Re-authorize the CURRENT actor. Fail-closed; must never throw (canRunCode). */
  authorize: (input: CanRunCodeInput) => Promise<CanRunCodeResult>;
  now: () => Date;
  /** Server-held secret for session-key derivation. */
  secret: string;
  /** REQUIRED full-egress enablement gate — see terminal-session-manager.ts. */
  checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  /**
   * Per-machine active-runtime cost backstop (Terminal Epic 1 T1.5, pulled
   * forward from Epic 3's full metering) — see quota.ts. Checked AFTER authz
   * (an unauthorized actor is denied on its own merits, not because the
   * machine happens to be busy) and BEFORE provisioning.
   */
  checkMachineRuntimeGuardrail: (input: { machineKey: string; now: number }) => MachineRuntimeGuardrailDecision;
  /** Record that the machine was just active, extending (or starting) its continuous-activity window. */
  recordMachineActivity: (input: { machineKey: string; now: number }) => void;
}

export interface AcquireMachineSandboxInput {
  tenantId: string;
  /** Absent for global (non-drive) contexts. */
  driveId?: string;
  userId: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  activeMachine?: MachineRefLike;
  deps: AcquireMachineSandboxDeps;
}

export type AcquireMachineSandboxResult =
  | { ok: true; sandboxId: string; resumed: boolean; pageId?: string }
  | {
      ok: false;
      reason:
        | CodeExecutionDenialReason
        | 'provision_failed'
        | 'no_machine'
        | FullEgressDenialReason
        | 'machine_runtime_exceeded';
      cause?: unknown;
    };

export async function acquireMachineSandbox(
  input: AcquireMachineSandboxInput,
): Promise<AcquireMachineSandboxResult> {
  const { deps, tenantId, driveId, userId, requestOrigin, agentPageId, activeMachine } = input;

  const pageId = resolveMachinePageId({ agentPageId, activeMachine });
  if (!pageId || !driveId) return { ok: false, reason: 'no_machine' };

  const authorization = await deps.authorize({ userId, driveId, requestOrigin, agentPageId });
  if (!authorization.ok) return { ok: false, reason: authorization.reason };

  const nowMs = deps.now().getTime();
  const guardrail = deps.checkMachineRuntimeGuardrail({ machineKey: pageId, now: nowMs });
  if (!guardrail.allowed) return { ok: false, reason: guardrail.reason };

  const result = await acquireTerminalSandbox({
    pageId,
    driveId,
    tenantId,
    userId,
    canRun: true, // just authorized above
    deps: {
      store: deps.store,
      client: deps.client,
      now: deps.now,
      secret: deps.secret,
      checkFullEgressEnablement: deps.checkFullEgressEnablement,
    },
  });

  if (!result.ok) {
    // 'deny' cannot arise here (canRun is always true) — mapped defensively.
    return { ok: false, reason: result.reason === 'deny' ? 'error' : result.reason, cause: result.cause };
  }

  deps.recordMachineActivity({ machineKey: pageId, now: nowMs });
  return { ok: true, sandboxId: result.sandboxId, resumed: result.resumed, pageId };
}
