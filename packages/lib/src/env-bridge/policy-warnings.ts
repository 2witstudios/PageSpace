/**
 * What a machine policy is quietly widening — said out loud (GA wave 3,
 * leaf 7; Codex P1 on #2584). Pure: a policy in, the lines a daemon should
 * print in. Nothing here refuses anything: both cases are the owner's
 * deliberate edit of their own file on their own machine, honoured as wave 1
 * ruled for the principals case. The daemon must simply be LOUD.
 *
 * - `principals_widen_d6` (wave 1): more than one principal named. Every one
 *   of them can run commands as the owner, subject to mode and ops; the
 *   server only ever binds the owner's sessions, so this widens nothing on
 *   the server side — remove the ones not meant.
 * - `exec_allowlisted` (wave 3): mode `allowlist` with `exec` in `ops`. The
 *   "exec always needs the owner's click" property (Tier B) holds only
 *   because the enroller never scaffolds `exec` into the machine ops; an
 *   owner who hand-edits it in runs every exec grant WITHOUT a click. Stated
 *   in one line naming the consequence and the way back.
 *
 * Printed by `env connect` (and audited there as
 * `policy_warning:exec_allowlisted`) and by `env policy`.
 */
import type { MachinePolicy } from './policy-types';

export type PolicyWarningCode = 'principals_widen_d6' | 'exec_allowlisted';

export interface PolicyWarning {
  readonly code: PolicyWarningCode;
  readonly message: string;
}

export const EXEC_ALLOWLISTED_WARNING = 'exec is allowlisted: commands run on this machine without a click — remove exec from ops to restore the approval prompt';

/** The lines a daemon prints for this policy, in a fixed order. Empty when there is nothing to say. */
export function policyWarnings(policy: Pick<MachinePolicy, 'mode' | 'ops' | 'principals'>): PolicyWarning[] {
  const warnings: PolicyWarning[] = [];
  if (policy.principals.length > 1) {
    warnings.push({
      code: 'principals_widen_d6',
      message:
        `[D-6] A machine is driven by its owner only, but this policy names ${policy.principals.length} principals (${policy.principals.join(', ')}): ` +
        "every one of them can run commands as you on this machine, subject to mode and ops. PageSpace itself only ever binds the environment owner's sessions, so extra principals here widen nothing on the server side; remove the ones you did not mean.",
    });
  }
  if (policy.mode === 'allowlist' && policy.ops.includes('exec')) {
    warnings.push({ code: 'exec_allowlisted', message: EXEC_ALLOWLISTED_WARNING });
  }
  return warnings;
}
