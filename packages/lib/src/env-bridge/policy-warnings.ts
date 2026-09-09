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
 * - `root_is_home` (hardening A6): a root that IS the owner's home directory,
 *   or an ancestor of it. `enroll` scaffolds `roots: [cwd]`, so enrolling from
 *   `$HOME` scopes an agent to `.ssh`, the shell rc files and every project at
 *   once — and the policy parser refuses only `/` and `..`, so nothing else
 *   catches it. Honoured like the other two ([D-7]: the owner's machine, the
 *   owner's file), and said out loud at enrol, at connect and at `env policy`.
 * - `exec_allowlisted` (wave 3): mode `allowlist` with `exec` in `ops`. The
 *   "exec always needs the owner's click" property (Tier B) holds only
 *   because the enroller never scaffolds `exec` into the machine ops; an
 *   owner who hand-edits it in runs every exec grant WITHOUT a click. Stated
 *   in one line naming the consequence and the way back.
 *
 * Printed by `env connect` (which audits every code it prints as
 * `policy_warning:<code>`) and by `env policy`.
 *
 * Pure: the home directory is INJECTED, never read here.
 */
import type { MachinePolicy } from './policy-types';

export type PolicyWarningCode = 'principals_widen_d6' | 'exec_allowlisted' | 'root_is_home';

export interface PolicyWarning {
  readonly code: PolicyWarningCode;
  readonly message: string;
}

export const EXEC_ALLOWLISTED_WARNING = 'exec is allowlisted: commands run on this machine without a click — remove exec from ops to restore the approval prompt';

/** The policy fields these warnings are decided from. */
export type PolicyWarningInput = Pick<MachinePolicy, 'mode' | 'ops' | 'principals' | 'roots'>;

export interface PolicyWarningOptions {
  /** The owner's home directory. Absent or empty ⇒ `root_is_home` is not decided at all: this module never guesses. */
  readonly homedir?: string | null;
}

/** Trailing slashes are not part of a directory's identity: `/home/u/` and `/home/u` are the same root. */
const trimSlashes = (path: string): string => {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
};

/** Is `root` the home directory itself, or a directory that CONTAINS it? */
function coversHome(root: string, homedir: string): boolean {
  const base = trimSlashes(root);
  const home = trimSlashes(homedir);
  return base === home || (base === '/' ? true : home.startsWith(`${base}/`));
}

/** The lines a daemon prints for this policy, in a fixed order. Empty when there is nothing to say. */
export function policyWarnings(policy: PolicyWarningInput, options: PolicyWarningOptions = {}): PolicyWarning[] {
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
  const homedir = options.homedir;
  if (typeof homedir === 'string' && homedir.length > 0) {
    const wide = policy.roots.find((root) => coversHome(root, homedir));
    if (wide !== undefined) {
      warnings.push({
        code: 'root_is_home',
        message:
          `A policy root (${wide}) covers your whole home directory: file operations run without a click anywhere inside it, which includes ~/.ssh, your shell startup files and every project on this machine at once. ` +
          'Narrow "roots" in the policy file to the specific project directories you meant, then restart the daemon.',
      });
    }
  }
  return warnings;
}
