/**
 * Branch-scoped sandbox acquisition (IO, dependency-injected).
 *
 * "PageSpace Agent" panes bound to a branch-terminal (`machine_branches`,
 * issue #2166 phase 5/9's `deriveMachinePaneBinding.branchSandbox`) run tools
 * on that branch's OWN isolated Sprite — never the owning Machine's
 * persistent one. Unlike `acquireMachineSandbox` (machine-session.ts), this
 * is attach-only: the branch's Sprite is provisioned exclusively by the
 * branch-spawn path (`machine-branches.ts`), so a missing or torn-down
 * branch fails closed here rather than lazily provisioning a replacement.
 *
 * Same authorize → guardrail → resolve → record-activity ORDERING as
 * `acquireMachineSandbox` (load-bearing there, load-bearing here too): an
 * unauthorized actor is denied on its own merits before the runtime
 * guardrail is even consulted, and activity is recorded only once the branch
 * is confirmed live. The guardrail and activity are keyed by the branch's
 * OWNING MACHINE page id (`machineId`), not the branch row's own id — the
 * runtime budget and payer (`lookupPageOwnerId(machineId)`) are the
 * Machine's, shared across its machine/project/branch scopes alike.
 */

import type { CanRunCodeInput, CanRunCodeResult, CodeExecutionDenialReason } from './can-run-code';
import type { MachineRuntimeGuardrailDecision, MachineRuntimeGuardrailReason } from './quota';

export interface AcquireBranchSandboxDeps {
  /** Re-authorize the CURRENT actor. Fail-closed; must never throw (canRunCode). */
  authorize: (input: CanRunCodeInput) => Promise<CanRunCodeResult>;
  now: () => Date;
  /** Same per-machine active-runtime cost backstop `acquireMachineSandbox` checks — see quota.ts. */
  checkMachineRuntimeGuardrail: (input: { machineKey: string; now: number }) => MachineRuntimeGuardrailDecision;
  /** Record that the machine was just active, extending (or starting) its continuous-activity window. */
  recordMachineActivity: (input: { machineKey: string; now: number }) => void;
  /** Fresh lookup of the branch's own Sprite — mirrors `MachinePaneBindingBranchLookup.findById` (machine-pane-binding.ts). */
  findBranch: (machineBranchId: string) => Promise<{ sandboxId: string; spriteTornDownAt: Date | null } | null>;
}

export interface AcquireBranchSandboxInput {
  /** Absent for global (non-drive) contexts. */
  driveId?: string;
  userId: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  /** The branch's owning Machine page id. */
  machineId: string;
  /** The `machine_branches` row id backing this branch-terminal. */
  machineBranchId: string;
  deps: AcquireBranchSandboxDeps;
}

export type AcquireBranchSandboxResult =
  | {
      ok: true;
      sandboxId: string;
      /**
       * Deliberately omitted (always undefined), NOT the branch's owning
       * `machineId`: `openSession` (tool-runners.ts) threads this straight
       * into the opportunistic storage-measurement seam and the Terminal
       * activity-feed notifier, both of which key off a MACHINE's own
       * `machine_sessions` row. The awake sandbox here is the branch's OWN,
       * separate Sprite — attributing its measured bytes (or activity) to
       * the machine's row would silently corrupt that machine's storage
       * billing. A dedicated branch-scoped seam for either is future work;
       * until then, omitting `pageId` cleanly opts branch runs out of both
       * (`openSession`'s `if (acquired.pageId && ...)` guards).
       */
      pageId?: undefined;
    }
  | { ok: false; reason: CodeExecutionDenialReason | MachineRuntimeGuardrailReason | 'branch_not_found' };

export async function acquireBranchSandbox(
  input: AcquireBranchSandboxInput,
): Promise<AcquireBranchSandboxResult> {
  const { deps, machineId, machineBranchId, userId, driveId, requestOrigin, agentPageId } = input;

  const authorization = await deps.authorize({ userId, driveId, requestOrigin, agentPageId });
  if (!authorization.ok) return { ok: false, reason: authorization.reason };

  const nowMs = deps.now().getTime();
  const guardrail = deps.checkMachineRuntimeGuardrail({ machineKey: machineId, now: nowMs });
  if (!guardrail.allowed) return { ok: false, reason: guardrail.reason };

  const branch = await deps.findBranch(machineBranchId);
  if (!branch || branch.spriteTornDownAt !== null) return { ok: false, reason: 'branch_not_found' };

  deps.recordMachineActivity({ machineKey: machineId, now: nowMs });
  return { ok: true, sandboxId: branch.sandboxId };
}
