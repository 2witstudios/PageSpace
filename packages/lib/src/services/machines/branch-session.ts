/**
 * Branch-terminal session identity (pure).
 *
 * A branch-terminal is its OWN Sprite — never the owning Machine's, and never
 * shared with any other branch of the same Project. `deriveBranchSessionKey`
 * mirrors `deriveMachineSessionKey` (services/sandbox/machine-session-manager.ts):
 * an opaque HMAC name, namespaced so a (tenant, machine, project, branch)
 * tuple ALWAYS resolves to the same Sprite name — and, critically, two
 * different branch names always resolve to two DIFFERENT Sprite names, so
 * `MachineHost.provision` (which auto-resumes "same name, same filesystem")
 * can never accidentally hand two branches the same underlying Sprite.
 */

import { createHmac } from 'crypto';
import { slugifySegment } from './name-slug';

export interface BranchSessionKeyInput {
  tenantId: string;
  machineId: string;
  projectName: string;
  branchName: string;
  secret: string;
}

const NAMESPACE_VERSION = 'branch-session:v1';

export function deriveBranchSessionKey({
  tenantId,
  machineId,
  projectName,
  branchName,
  secret,
}: BranchSessionKeyInput): string {
  if (secret.length === 0) {
    throw new Error('deriveBranchSessionKey requires a non-empty secret');
  }
  const payload = [NAMESPACE_VERSION, tenantId, machineId, projectName, branchName].join('\0');
  // codeql[js/insufficient-password-hash] not a password hash — a keyed HMAC over SANDBOX_SESSION_SECRET (a >=32-char server secret, never user input) deriving a deterministic Sprite-name pseudonym, same as machine-session-manager.ts's deriveMachineSessionKey
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-brn-${digest}`;
}

const MAX_BRANCH_NAME_LENGTH = 200;

// Mirrors `git check-ref-format --branch` intent without shelling out: the
// allowed charset already excludes whitespace/control chars and
// `~^:?*[\` — the remaining checks below rule out `..`, doubled `/`, a path
// segment starting with `.`, and a `.lock` suffix. Conservative on purpose —
// this becomes both a Sprite name component and a literal `git checkout -b`
// argument (never shell-interpreted, but still worth confining tightly).
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const FORBIDDEN_SEGMENT_RE = /(^|\/)\.|\.\.|\/{2,}|\.lock$/;

export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH) {
    return false;
  }
  if (name.endsWith('/') || name.endsWith('.')) return false;
  if (!BRANCH_NAME_RE.test(name)) return false;
  if (FORBIDDEN_SEGMENT_RE.test(name)) return false;
  return true;
}

/** Every separator a ref may carry, for trimming an edge the length cut exposed. */
const TRAILING_REF_SEPARATORS_RE = /[./-]+$/;

const LOCK_SUFFIX = '.lock';

/** What an input with nothing sluggable left in it becomes ("   ", "🚀", "..."). */
export const BRANCH_NAME_FALLBACK = 'branch';

/**
 * Normalize free text into a valid git branch name — type "My Cool Feature",
 * get `my-cool-feature`. This is the normalize-and-accept counterpart to
 * `isValidBranchName`, which stays exactly as it is: the predicate remains the
 * CONTRACT, and this function's job is to satisfy it for any input at all,
 * rather than to reject the user.
 *
 * `/` is structural — it is how git namespaces refs — so it survives as a
 * segment separator and each segment is slugified independently
 * (`feat/JIRA-123 Fix!!` → `feat/jira-123-fix`). Empty segments vanish, which
 * is what disarms `../escape` (→ `escape`) and `a//b` (→ `a/b`).
 *
 * INVARIANT: `isValidBranchName(normalizeBranchName(x)) === true` for EVERY
 * string x, and the function is idempotent. The closing guard makes the first
 * half of that total rather than merely intended — a slug that somehow still
 * fails the predicate degrades to the fallback instead of reaching git.
 */
export function normalizeBranchName(input: string): string {
  const segments = input
    .split('/')
    .map(slugifySegment)
    .filter((segment) => segment.length > 0);

  let name = segments.join('/');

  if (name.length > MAX_BRANCH_NAME_LENGTH) {
    name = name.slice(0, MAX_BRANCH_NAME_LENGTH).replace(TRAILING_REF_SEPARATORS_RE, '');
  }

  // A `.lock` suffix is a forbidden ref name — and the cut above can itself
  // mint one (`hotfix.lockdown` truncated at the limit), so this runs last.
  if (name.endsWith(LOCK_SUFFIX)) {
    name = `${name.slice(0, -LOCK_SUFFIX.length)}-lock`;
  }

  return isValidBranchName(name) ? name : BRANCH_NAME_FALLBACK;
}
