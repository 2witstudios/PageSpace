/**
 * Promoted-project sandbox acquisition (IO, dependency-injected).
 *
 * The project-tier twin of `acquireBranchSandbox` (./branch-session.ts), and
 * deliberately identical in every load-bearing respect — a PROMOTED project
 * (issue #2204 phase 7, `machines/machine-project-promotion.ts`) has its OWN
 * isolated Sprite exactly like a branch-terminal does, so a run bound to one
 * must attach to that Sprite and never to the owning Machine's persistent
 * session.
 *
 * Attach-only, for the same reason: a promoted project's Sprite is provisioned
 * exclusively by `promoteProject`, so a row that is not (or is no longer)
 * promoted fails CLOSED here rather than lazily provisioning a replacement
 * nothing asked for.
 *
 * Same authorize → guardrail → resolve → record-activity ORDERING, and the same
 * attribution: the guardrail and activity are keyed by the OWNING MACHINE page
 * id, not the project row's own id — the runtime budget and payer are the
 * Machine's, shared across its machine/project/branch scopes alike.
 */

import type { CanRunCodeInput, CanRunCodeResult, CodeExecutionDenialReason } from './can-run-code';
import type { MachineRuntimeGuardrailDecision, MachineRuntimeGuardrailReason } from './quota';

export interface AcquireProjectSandboxDeps {
  /** Re-authorize the CURRENT actor. Fail-closed; must never throw (canRunCode). */
  authorize: (input: CanRunCodeInput) => Promise<CanRunCodeResult>;
  now: () => Date;
  /** Same per-machine active-runtime cost backstop `acquireMachineSandbox` checks — see quota.ts. */
  checkMachineRuntimeGuardrail: (input: { machineKey: string; now: number }) => MachineRuntimeGuardrailDecision;
  /** Record that the machine was just active, extending (or starting) its continuous-activity window. */
  recordMachineActivity: (input: { machineKey: string; now: number }) => void;
  /** Fresh lookup of the project's own Sprite — a re-read, so a teardown between derivation and acquire is noticed. */
  findProject: (machineProjectId: string) => Promise<{ sandboxId: string | null; spriteTornDownAt: Date | null } | null>;
}

export interface AcquireProjectSandboxInput {
  /** Absent for global (non-drive) contexts. */
  driveId?: string;
  userId: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  /** The project's owning Machine page id. */
  machineId: string;
  /** The `machine_projects` row id backing this promoted project. */
  machineProjectId: string;
  deps: AcquireProjectSandboxDeps;
}

export type AcquireProjectSandboxResult =
  | {
      ok: true;
      sandboxId: string;
      /**
       * Deliberately omitted (always undefined), for the identical reason
       * `AcquireBranchSandboxResult` omits it: `openSession` threads this into
       * the machine-keyed storage-measurement and activity-feed seams, and the
       * awake sandbox here is the PROJECT's own, separate Sprite — attributing
       * its bytes to the machine's `machine_sessions` row would corrupt that
       * machine's own storage billing.
       */
      pageId?: undefined;
    }
  | { ok: false; reason: CodeExecutionDenialReason | MachineRuntimeGuardrailReason | 'project_not_found' };

export async function acquireProjectSandbox(
  input: AcquireProjectSandboxInput,
): Promise<AcquireProjectSandboxResult> {
  const { deps, machineId, machineProjectId, userId, driveId, requestOrigin, agentPageId } = input;

  const authorization = await deps.authorize({ userId, driveId, requestOrigin, agentPageId });
  if (!authorization.ok) return { ok: false, reason: authorization.reason };

  const nowMs = deps.now().getTime();
  const guardrail = deps.checkMachineRuntimeGuardrail({ machineKey: machineId, now: nowMs });
  if (!guardrail.allowed) return { ok: false, reason: guardrail.reason };

  const project = await deps.findProject(machineProjectId);
  if (!project || !project.sandboxId || project.spriteTornDownAt !== null) {
    return { ok: false, reason: 'project_not_found' };
  }

  deps.recordMachineActivity({ machineKey: machineId, now: nowMs });
  return { ok: true, sandboxId: project.sandboxId };
}
