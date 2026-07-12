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
// segment starting with `.`, and a `.lock` segment. Conservative on purpose —
// this becomes both a Sprite name component and a literal `git checkout -b`
// argument (never shell-interpreted, but still worth confining tightly).
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// `\.lock(\/|$)` — NOT just `\.lock$`: git forbids a `.lock` ending on EVERY
// slash-separated component, so `a.lock/b` is as fatal to `git checkout -b` as
// a trailing one is (git-check-ref-format(1)).
const FORBIDDEN_SEGMENT_RE = /(^|\/)\.|\.\.|\/{2,}|\.lock(\/|$)/;

// `git check-ref-format --branch HEAD` is fatal — HEAD is the reserved symbolic
// ref, and it is the ONLY such name in the charset above (`head`, `Head`, and
// `FETCH_HEAD` are all legal branches; verified against git).
const RESERVED_BRANCH_NAMES = new Set(['HEAD']);

export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH) {
    return false;
  }
  if (RESERVED_BRANCH_NAMES.has(name)) return false;
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
 * Rewrite a `.lock` ending into `-lock`. Applied PER SEGMENT, because git
 * forbids the suffix on every slash-separated component, not merely on the ref
 * as a whole — `feature/a.lock/foo` is fatal to `git checkout -b` even though
 * the ref doesn't end in `.lock`. Length-preserving, so it can safely run after
 * the length cut too (which can itself mint one).
 */
function rewriteLockSuffix(segment: string): string {
  return segment.endsWith(LOCK_SUFFIX) ? `${segment.slice(0, -LOCK_SUFFIX.length)}-lock` : segment;
}

/**
 * Normalize free text into a valid git branch name — type "My Cool Feature",
 * get `my-cool-feature`. This is the normalize-and-accept counterpart to
 * `isValidBranchName`, which stays exactly as it is: the predicate remains the
 * CONTRACT, and this function's job is to satisfy it for any input at all,
 * rather than to reject the user.
 *
 * A name git ALREADY accepts is returned untouched. This is not a shortcut —
 * it is load-bearing. Git refs are case-sensitive, so slugifying `Release-2.0`
 * to `release-2.0` would make `git checkout -b release-2.0 origin/release-2.0`
 * miss the real upstream branch, and `cloneAndCheckoutBranch`'s fallback would
 * then silently hand the user a NEW EMPTY branch off HEAD while
 * `origin/Release-2.0` sat there untouched. Same for `_`, which git allows.
 * Normalization exists to accept text git would REJECT — never to rewrite text
 * git would have honored.
 *
 * `/` is structural — it is how git namespaces refs — so it survives as a
 * segment separator and each segment is slugified independently
 * (`feat/JIRA-123 Fix!!` → `feat/jira-123-fix`). Empty segments vanish, which
 * is what disarms `../escape` (→ `escape`) and `a//b` (→ `a/b`).
 *
 * INVARIANT: `isValidBranchName(normalizeBranchName(x)) === true` for EVERY
 * string x, and the function is idempotent (which the pass-through above makes
 * immediate: the output is always valid, so a second pass is the identity).
 * The closing guard makes the invariant total rather than merely intended — a
 * slug that somehow still fails the predicate degrades to the fallback instead
 * of reaching git.
 */
export function normalizeBranchName(input: string): string {
  if (isValidBranchName(input)) return input;

  const segments = input
    .split('/')
    .map((segment) => rewriteLockSuffix(slugifySegment(segment)))
    .filter((segment) => segment.length > 0);

  let name = segments.join('/');

  if (name.length > MAX_BRANCH_NAME_LENGTH) {
    // The cut only ever lands in the LAST surviving segment (it drops a
    // suffix), so re-trimming and re-checking `.lock` there is enough — the cut
    // can mint one out of thin air (`hotfix.lockdown` truncated at the limit).
    name = rewriteLockSuffix(name.slice(0, MAX_BRANCH_NAME_LENGTH).replace(TRAILING_REF_SEPARATORS_RE, ''));
  }

  return isValidBranchName(name) ? name : BRANCH_NAME_FALLBACK;
}
