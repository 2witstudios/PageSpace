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
import { slugifySegment, disambiguateSlug, truncateWithDigest } from './name-slug';

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

const LOCK_SUFFIX = '.lock';

/** What an input with nothing sluggable left in it becomes ("   ", "🚀", "..."). */
const BRANCH_NAME_FALLBACK = 'branch';

/**
 * Rewrite a `.lock` ending into `-lock`. Applied PER SEGMENT, because git
 * forbids the suffix on every slash-separated component, not merely on the ref
 * as a whole — `feature/a.lock/foo` is fatal to `git checkout -b` even though
 * the ref doesn't end in `.lock`. The length cut can no longer mint one, since
 * it appends an alphanumeric digest.
 */
function rewriteLockSuffix(segment: string): string {
  return segment.endsWith(LOCK_SUFFIX) ? `${segment.slice(0, -LOCK_SUFFIX.length)}-lock` : segment;
}

/**
 * Normalize one `/`-separated component. `rewriteLockSuffix` runs BEFORE
 * `disambiguateSlug` (see its doc) — a segment must be a legal ref *before* a
 * digest is appended to it, or `foo.lock` would keep its forbidden ending.
 */
function normalizeBranchSegment(segment: string): string {
  return disambiguateSlug(segment, rewriteLockSuffix(slugifySegment(segment)));
}

/**
 * Normalize free text into a valid git branch name — type "My Cool Feature",
 * get `my-cool-feature`. This is the normalize-and-accept counterpart to
 * `isValidBranchName`, which stays as it is: the predicate remains the CONTRACT,
 * and this function's job is to satisfy it for any input at all rather than to
 * reject the user.
 *
 * A name `isValidBranchName` ALREADY accepts is returned untouched, and that is
 * load-bearing, not a shortcut. Git refs are case-sensitive: slugifying
 * `Release-2.0` to `release-2.0` made `git checkout -b release-2.0
 * origin/release-2.0` miss the real upstream branch, and
 * `cloneAndCheckoutBranch`'s fallback then silently handed the user a NEW EMPTY
 * branch off HEAD while `origin/Release-2.0` sat there untouched. Uppercase and
 * `_` both pass the predicate, so both now survive.
 *
 * CAVEAT, deliberately accepted: the predicate is NARROWER than git's own rule.
 * Git would accept `_wip`, `fix#123`, `v1.0+build`, `日本語`; we do not, because
 * this charset is a confinement boundary (the name lands in `git checkout -b`
 * argv, a store key, and a scope key). Such names are therefore still rewritten,
 * and if one of them names an EXISTING upstream branch, git's fallback creates a
 * new empty branch off HEAD instead. `spawnBranch` reports that as `createdNew`
 * so the outcome is at least KNOWABLE — though nothing renders it to the user
 * yet; that belongs with the spawn-flow sub-task. Widening the charset to git's
 * full rule is a separate, security-reviewable change.
 *
 * `/` is structural — it is how git namespaces refs — so it survives as a
 * segment separator and each segment is normalized independently
 * (`feat/JIRA-123 Fix!!` → `feat/jira-123-fix`). Content-free segments vanish,
 * which is what disarms `../escape` (→ `escape`) and `a//b` (→ `a/b`); a segment
 * that DID carry a name the charset cannot express keeps a digest token instead
 * of vanishing (see `normalizeBranchSegment`).
 *
 * INVARIANT: `isValidBranchName(normalizeBranchName(x)) === true` for EVERY
 * string x, and the function is idempotent (immediate from the pass-through: the
 * output is always valid, so a second pass is the identity). The closing guard
 * makes the invariant total rather than merely intended — a slug that somehow
 * still fails the predicate degrades to the fallback instead of reaching git.
 */
export function normalizeBranchName(rawInput: string): string {
  // Trim FIRST: a stray trailing space would otherwise fail the predicate and
  // send `Release-2.0 ` down the slug path, downcasing it — resurrecting the very
  // case-regression the pass-through exists to prevent.
  const input = rawInput.trim();
  if (isValidBranchName(input)) return input;

  const segments = input
    .split('/')
    .map(normalizeBranchSegment)
    .filter((segment) => segment.length > 0);

  const name = truncateWithDigest(segments.join('/'), input, MAX_BRANCH_NAME_LENGTH);

  return isValidBranchName(name) ? name : BRANCH_NAME_FALLBACK;
}
