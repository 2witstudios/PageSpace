/**
 * Lazy project-Sprite promotion (IO, dependency-injected).
 *
 * A Project is born as a git checkout on the OWNING Machine's own persistent
 * Sprite (`machine_projects.path`, under `PROJECTS_ROOT` — see
 * `machine-projects.ts`). That is enough for everything the cascade does at
 * project scope: an unpromoted project resolves to "the machine's Sprite, at
 * this cwd". PROMOTION is the one-way step that gives a project its OWN
 * isolated Sprite — the same isolation a branch-terminal has always had — and
 * from that moment every resolution (agent tools AND the realtime PTY bridge)
 * flips to that Sprite with `cwd = PROJECT_REPO_PATH`.
 *
 * This is `spawnBranch`'s provisioning template (`machine-branches.ts`)
 * generalized one tier up, and deliberately so: same `MachineHost` seam, same
 * HMAC-named provision (`deriveProjectSessionKey`, its own namespace), same
 * hardened `runGitInSandbox` clone, same `propagateClaudeCredential` copy from
 * the root Machine's Sprite, same identity columns to CAS against, and the same
 * storage-attribution key (the OWNING Machine page — a promoted project is not
 * its own payer any more than a branch is).
 *
 * Two things promotion has that a branch spawn does not:
 *
 *  1. **A dirty-tree refusal.** Promotion MOVES a project's home. The old
 *     checkout on the machine Sprite is reclaimed afterwards, and the new Sprite
 *     is a fresh clone from `repoUrl` — so any uncommitted work sitting in the
 *     old checkout would be destroyed by a step the user did not ask for.
 *     Promotion therefore REFUSES, with an actionable message, unless the
 *     machine-side checkout is confirmed clean (or confirmed absent). A checkout
 *     whose state we could not determine refuses too: fail-closed, because the
 *     failure mode on the other side is silent data loss.
 *  2. **A compare-and-swap persist.** Two concurrent project-scoped spawns race
 *     to promote the same project. `MachineProjectStore.promote` writes only
 *     while the row is still unpromoted, so the loser reconciles against the
 *     winner's row rather than overwriting it and orphaning a live VM.
 */

import type { SubscriptionTier } from '../subscription-utils';
import { runGitInSandbox, type GitSandboxRunDeps } from '../sandbox/git-tool-runners';
import type { SandboxQuotaDeps } from '../sandbox/tool-runners';
import { SANDBOX_ROOT } from '../sandbox/sandbox-paths';
import { SANDBOX_TIMEOUT_MS, SANDBOX_MAX_OUTPUT_BYTES } from '../sandbox/execution-policy';
import type { ExecutableSandbox } from '../sandbox/sandbox-client/types';
import type { MachineHost, MachineHandle, MachineSubstrateSpec } from '../sandbox/machine-host';
import { adaptMachineHandleToExecutableSandbox } from '../sandbox/sandbox-client/machine-host-adapter';
import type { SandboxCreateOptions } from '../sandbox/sandbox-options';
import type { FullEgressEnablement, FullEgressDenialReason } from '../sandbox/containment';
import type { CodeExecutionAuditInput } from '../sandbox/audit';
import { buildActorCtx, propagateClaudeCredential, type MachineActorContext } from './machine-branches';
import { normalizeProjectName } from './project-paths';
import { deriveProjectSessionKey } from './project-session';
import type { MachineProjectRecord, MachineProjectStore } from './machine-projects-store';

export type { MachineActorContext };

// Defined in sandbox-paths.ts (so light-weight consumers don't import this
// module's whole graph for a string); imported for local use and re-exported
// for existing callers.
import { PROJECT_REPO_PATH } from '../sandbox/sandbox-paths';
export { PROJECT_REPO_PATH };

/** How many extra reads `awaitPromotionWinner` makes after its first, and how long it pauses between them. */
const PROMOTION_RACE_POLLS = 3;
const PROMOTION_RACE_POLL_MS = 250;

/**
 * Where a carry bundle is staged on BOTH Sprites.
 *
 * The Sprite user's persistent home, deliberately OUTSIDE `SANDBOX_ROOT` — the
 * same rule `GH_CONFIG_DIR` follows (`git-tool-runners.ts`): a stray file under
 * `/workspace` makes the root non-empty and breaks a no-path `git clone`.
 */
const CARRY_BUNDLE_DIR = '/home/sprite';
/** The ref namespace the bundle is fetched into on the project Sprite, and the fallback branch name for a detached HEAD. */
const CARRY_REF_NAMESPACE = 'pagespace-carry';
const CARRY_COMMIT_MESSAGE = 'pagespace: carried working tree during project promotion';

/**
 * Hard cap on a carry bundle, because the transfer reads the WHOLE file into
 * this process's memory (`readFileToBuffer` → `writeFiles`). Without it, one
 * project with a large history is an OOM of the web server, not a failed
 * promotion. Refusing over the cap is recoverable — the user can push and
 * promote without a carry — so the cap is the safe side.
 */
export const MAX_CARRY_BUNDLE_BYTES = 64 * 1024 * 1024;

export type PromoteProjectDenialReason =
  | 'kill_switch_off'
  | 'project_not_found'
  /** The machine-side checkout has uncommitted work — promoting would destroy it. */
  | 'dirty_checkout'
  /** `carryDirty` was asked for and the carry could not be completed (issue #2207). */
  | 'carry_failed'
  /** The carry bundle exceeds `MAX_CARRY_BUNDLE_BYTES` — see that constant. */
  | 'carry_too_large'
  /**
   * The machine-side checkout is CLEAN but holds commits that exist nowhere
   * else. A fresh clone from `repoUrl` cannot reproduce them. (Issue #2204
   * follow-up, F1.)
   */
  | 'unpushed_commits'
  /** We could not determine whether the machine-side checkout is clean. Fail-closed. */
  | 'dirty_check_failed'
  | 'provision_failed'
  | 'clone_failed'
  | 'error';

/** Input to the promoted-project storage-measurement seam — the project's own row plus its attribution key. */
export interface ProjectStorageMeasurement {
  /** The `machine_projects` row the measurement is persisted on. */
  machineProjectId: string;
  /**
   * The owning Machine page the measured bytes bill to. A promoted project's
   * Sprite has its own filesystem but is NOT its own payer or line item — it
   * inherits the branch-Sprite attribution key (issue #2204 phase 3,
   * `machine-storage-attribution.ts`), which is the guardrail/payer key every
   * other node-scoped cost on this machine already uses.
   */
  machinePageId: string;
  /** The promoted Sprite's ALREADY-LIVE handle — measurement never provisions or wakes one. */
  handle: MachineHandle;
}

export type MachineAcquireResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | { ok: false; reason: string; cause?: unknown };

/** The slice of the Projects store promotion needs: find the row, and CAS the Sprite identity onto it. */
export type MachineProjectPromotionStore = Pick<MachineProjectStore, 'findByName' | 'findById' | 'promote'>;

export interface PromoteProjectDeps {
  store: MachineProjectPromotionStore;
  isEnabled: () => boolean;
  now: () => Date;
  /**
   * Pause, injected so the promotion-race reconciliation is testable without a
   * real clock (see `awaitPromotionWinner`).
   */
  wait: (ms: number) => Promise<void>;
  /** The provider-neutral Sprite lifecycle seam — the promoted project's own Sprite is provisioned through it. */
  host: MachineHost;
  substrate: MachineSubstrateSpec;
  options: SandboxCreateOptions;
  /** Server-held secret for session-key derivation (same secret as machine-session-manager.ts). */
  secret: string;
  /** REQUIRED full-egress enablement gate — a promoted project's Sprite runs open egress, same as a branch's. */
  checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  resolveGitHubToken: (userId: string) => Promise<string | null>;
  /** Live handle to the OWNING Machine's own persistent Sprite — the source the Claude Code credential is copied from. `null` when it has no live session yet (graceful no-op). */
  resolveRootMachineHandle: (machineId: string) => Promise<MachineHandle | null>;
  /**
   * Acquire the OWNING Machine's persistent Sprite. Promotion needs it for the
   * two steps that happen on the OLD home: the dirty-tree check, and the
   * post-promotion checkout reclaim.
   */
  acquireMachineSandbox: (machineId: string) => Promise<MachineAcquireResult>;
  reconnect: (sandboxId: string) => Promise<ExecutableSandbox | null>;
  quota: SandboxQuotaDeps;
  buildEnv: () => Record<string, string>;
  audit: (input: CodeExecutionAuditInput) => Promise<void>;
  screenOutput?: (text: string) => Promise<string>;
  /**
   * Optional opportunistic storage-measurement seam, mirroring
   * `MachineBranchesDeps.measureBranchStorage`: while the promoted Sprite is
   * ALREADY awake for the clone, capture its used bytes so the storage
   * reconcile can bill them to the OWNING Machine page without ever waking a
   * hibernating Sprite. Best-effort and fire-and-forget — a failure must never
   * affect the promotion.
   */
  measureProjectStorage?: (input: ProjectStorageMeasurement) => Promise<void>;
  /**
   * Re-measure the OWNING Machine's own Sprite after its copy of the project
   * checkout is reclaimed (issue #2204 follow-up, F12). The root's last
   * persisted measurement still counts the bytes we removed, so without this
   * the reconcile bills them on the machine AND on the new project Sprite until
   * some unrelated root operation happens to refresh it. Best-effort, and
   * FORCED past the ordinary measurement throttle — the caller is reporting a
   * known shrink, not an opportunistic wake.
   */
  remeasureMachineStorage?: (input: { machinePageId: string }) => Promise<void>;
}

export type PromoteProjectResult =
  | {
      ok: true;
      /** The promoted project's OWN Sprite. */
      sandboxId: string;
      /** The HMAC name that Sprite is provisioned under. */
      sessionKey: string;
      /** `false` when this call found the project ALREADY promoted and simply reattached. */
      promoted: boolean;
      /** `true` when the Sprite already existed (an already-promoted project, or a race we lost). */
      resumed: boolean;
      /**
       * `true` when work was CARRIED from the machine checkout onto this Sprite
       * (issue #2207). The carried working-tree changes land as UNCOMMITTED
       * changes, but the staged/unstaged split is not preserved — everything
       * comes back unstaged.
       */
      carried: boolean;
    }
  | { ok: false; reason: PromoteProjectDenialReason | FullEgressDenialReason; detail?: string };

/** A project is promoted exactly when it points at a Sprite we still believe is alive. */
export function isPromotedProject(
  project: Pick<MachineProjectRecord, 'sandboxId' | 'spriteTornDownAt'>,
): boolean {
  return project.sandboxId !== null && project.spriteTornDownAt === null;
}

/** See the identically-named helper in `machine-branches.ts`: measurement is a background billing concern and must never be awaited by (or fail) the user-facing call. */
function noteProjectStorage(
  measure: ((input: ProjectStorageMeasurement) => Promise<void>) | undefined,
  input: ProjectStorageMeasurement,
): void {
  if (!measure) return;
  void measure(input).catch(() => {
    /* Best-effort: the seam already logs; a promotion must never fail on it. */
  });
}

/** See `noteProjectStorage`: a billing refresh must never be awaited by, or fail, the promotion. */
function noteRootStorageAfterReclaim(machineId: string, deps: PromoteProjectDeps): void {
  if (!deps.remeasureMachineStorage) return;
  void deps.remeasureMachineStorage({ machinePageId: machineId }).catch(() => {
    /* Best-effort: the seam already logs. */
  });
}

/** Git deps bound directly to the already-provisioned project handle — mirrors `machine-branches.ts`'s `buildGitDepsForHandle`. */
function buildGitDepsForHandle(handle: MachineHandle, deps: PromoteProjectDeps): GitSandboxRunDeps {
  const sandbox = adaptMachineHandleToExecutableSandbox(handle);
  return {
    isEnabled: deps.isEnabled,
    resolveGitHubToken: deps.resolveGitHubToken,
    acquireSandbox: async () => ({ ok: true, sandboxId: handle.machineId, resumed: false }),
    reconnect: async () => sandbox,
    quota: deps.quota,
    buildEnv: deps.buildEnv,
    audit: deps.audit,
    screenOutput: deps.screenOutput,
    now: deps.now,
  };
}

/** Git deps bound to the OWNING Machine's persistent Sprite — mirrors `machine-projects.ts`'s `buildGitRunDeps`. */
function buildGitDepsForMachine(machineId: string, deps: PromoteProjectDeps): GitSandboxRunDeps {
  return {
    isEnabled: deps.isEnabled,
    resolveGitHubToken: deps.resolveGitHubToken,
    acquireSandbox: async () => {
      const result = await deps.acquireMachineSandbox(machineId);
      if (!result.ok) return { ok: false, reason: 'provision_failed' };
      return { ok: true, sandboxId: result.sandboxId, resumed: result.resumed };
    },
    reconnect: deps.reconnect,
    quota: deps.quota,
    buildEnv: deps.buildEnv,
    audit: deps.audit,
    screenOutput: deps.screenOutput,
    now: deps.now,
  };
}

export type CheckoutState =
  /** Nothing to lose — the machine-side checkout is gone (or was never cloned). */
  | { kind: 'absent' }
  | { kind: 'clean' }
  | { kind: 'dirty'; detail: string }
  /** Clean tree, but commits a fresh clone could not reproduce. */
  | { kind: 'unpushed'; detail: string }
  /** We could not tell. Treated exactly like dirty (fail-closed), with its own reason. */
  | { kind: 'unknown'; detail: string };

/**
 * Classify `git status --porcelain -b` output (pure).
 *
 * A CLEAN WORKING TREE IS NOT THE SAME AS "NOTHING TO LOSE" — the gap this
 * closes (issue #2204 follow-up, F1). Promotion replaces the old checkout with
 * a fresh clone from `repoUrl`, so the question is not "are there uncommitted
 * edits" but "can a clone reproduce this checkout". A branch sitting two
 * commits ahead of its upstream answers no, and `--porcelain` alone reports it
 * as pristine — so promotion deleted the only copy of that work.
 *
 * The branch header (`-b`) answers it. Both fail-closed cases are deliberate:
 *
 *  • `[ahead N]` — commits exist here and nowhere else.
 *  • NO upstream at all (a locally-created branch, or a detached HEAD) — there
 *    is no remote ref this checkout is reproducible from, which is the same
 *    loss with less information.
 *
 * A missing header is `unknown`, not `clean`: `-b` always emits one, so its
 * absence means we are not reading what we think we are.
 */
/**
 * The `[ahead 1, behind 2]` payload of a porcelain branch header, or `''`.
 *
 * Index arithmetic rather than a pattern, so no amount of `[` in a branch name
 * can make this superlinear — see the call site.
 */
function trackingDivergence(branchLine: string): string {
  const open = branchLine.lastIndexOf('[');
  if (open === -1) return '';
  const close = branchLine.indexOf(']', open + 1);
  return close === -1 ? '' : branchLine.slice(open + 1, close);
}

export function classifyCheckoutStatus(stdout: string): CheckoutState {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  const branchLine = lines.find((line) => line.startsWith('## '));
  // Porcelain output covers untracked files too, and that is intended: an
  // untracked file in the old checkout is exactly the kind of work a fresh
  // clone on a new Sprite would silently drop.
  const changes = lines.filter((line) => !line.startsWith('## '));

  if (changes.length > 0) return { kind: 'dirty', detail: changes.join('\n') };
  if (!branchLine) return { kind: 'unknown', detail: 'git status reported no branch header' };

  const branch = branchLine.slice(3).trim();
  // Sliced, not matched with a `.*`-wrapped pattern: `git status` output is
  // attacker-influencable (a branch name is user input), and a regex that scans
  // the whole line for a bracketed group backtracks polynomially on a line full
  // of `[`. Taking the divergence hint by index bounds the regex to the short
  // `ahead N, behind M` payload, where the pattern is linear.
  const divergence = trackingDivergence(branch);
  const ahead = /\bahead (\d+)/.exec(divergence);
  if (ahead) {
    return { kind: 'unpushed', detail: `${ahead[1]} commit(s) not on the remote (${branch})` };
  }
  // `[gone]` — the branch still NAMES an upstream, but that ref no longer
  // exists on the remote (deleted after a merge, or a force-pruned fork). Git
  // then reports no ahead/behind counts at all, so the `...` below would read
  // this as tracked-and-in-sync when in fact NOTHING on the remote can
  // reproduce this branch. That is the same loss as having no upstream at all.
  if (/\bgone\b/.test(divergence)) {
    return { kind: 'unpushed', detail: `the upstream branch no longer exists on the remote (${branch})` };
  }
  // `## name...upstream` is the only shape that names a remote ref. Anything
  // else — `## name`, `## HEAD (no branch)` — has nothing to be reproduced from.
  if (!branch.includes('...')) {
    return { kind: 'unpushed', detail: `no upstream branch to reproduce this checkout from (${branch})` };
  }
  return { kind: 'clean' };
}

/**
 * The LOCAL branch name from a porcelain branch header, or `null` when the
 * checkout has none (detached HEAD, or output we cannot read). Pure.
 *
 * The carry needs a NAME because `git bundle` can only carry refs and the far
 * side has to check something out. A detached HEAD has none, which is why
 * `buildCarryPlan` answers that case by MAKING one rather than failing.
 */
export function parseCheckoutBranchName(stdout: string): string | null {
  const branchLine = stdout.split('\n').find((line) => line.startsWith('## '));
  if (!branchLine) return null;
  const header = branchLine.slice(3).trim();
  if (header.startsWith('HEAD (no branch)')) return null;
  // A repo with no commits yet: `## No commits yet on main`. The branch exists
  // (it is just unborn), and the carry commit is what gives it a tip.
  const unborn = 'No commits yet on ';
  const named = header.startsWith(unborn) ? header.slice(unborn.length) : header;
  // A branch name can contain neither a space nor `...` (git forbids both), so
  // cutting at the first of each leaves exactly the local name — and, unlike a
  // pattern, cannot backtrack on a hostile name (see `classifyCheckoutStatus`).
  const local = named.split(' ')[0].split('...')[0];
  return local.length > 0 ? local : null;
}

/**
 * Is this checkout state one a carry could rescue? (Pure.)
 *
 * `unknown` is deliberately NOT carryable, and that is the whole fail-closed
 * argument restated: we could not read the checkout, so we cannot bundle it
 * either — carrying would mean promoting on the PROMISE that the work came
 * across, which is exactly the silent loss the refusal exists to prevent.
 */
export function isCarryableState(state: CheckoutState): boolean {
  return state.kind === 'dirty' || state.kind === 'unpushed';
}

/** The ordered decisions a carry makes, derived from the checkout state alone. */
export interface CarryPlan {
  /** Dirty tree ⇒ everything becomes one commit first. A clean-but-unpushed tree has nothing to commit. */
  needsCommit: boolean;
  /** Detached HEAD ⇒ mint `pagespace-carry` so `bundle --all` has a ref to carry. */
  needsBranchCreate: boolean;
  /** Undo the carry commit on the FAR side, so the work reappears as uncommitted changes. Exactly `needsCommit`. */
  needsReset: boolean;
  branch: string;
  bundlePath: string;
  fetchRefspec: string;
  checkoutTarget: string;
}

export function buildCarryPlan({
  state,
  branchName,
  projectId,
}: {
  state: CheckoutState;
  branchName: string | null;
  projectId: string;
}): CarryPlan {
  const needsCommit = state.kind === 'dirty';
  const branch = branchName ?? CARRY_REF_NAMESPACE;
  // The id is ours (a database key), but it reaches a filesystem path, so it is
  // reduced to a tame filename rather than trusted — a path component that
  // escapes would stage the bundle somewhere nobody expects.
  const safeId = projectId.replace(/[^A-Za-z0-9_-]/g, '');
  return {
    needsCommit,
    needsBranchCreate: branchName === null,
    needsReset: needsCommit,
    branch,
    bundlePath: `${CARRY_BUNDLE_DIR}/${CARRY_REF_NAMESPACE}-${safeId}.bundle`,
    fetchRefspec: `+refs/heads/*:refs/remotes/${CARRY_REF_NAMESPACE}/*`,
    checkoutTarget: `${CARRY_REF_NAMESPACE}/${branch}`,
  };
}

/** `stat -c %s` output → byte count, or `null` when it is not a plain integer (the caller then fails closed). Pure. */
export function parseFileSizeBytes(stdout: string): number | null {
  const text = stdout.trim();
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

/**
 * May the old checkout be reclaimed after a CARRY? (Pure.)
 *
 * The ordinary reclaim gate demands a fresh `clean`, which a carried checkout
 * can never be: we committed the work, so the tree is clean but one commit
 * ahead — `unpushed`. Left at that, every carried promotion would leak its old
 * checkout, billed on the machine AND on the new Sprite forever.
 *
 * So the question becomes "is this tree still EXACTLY what we bundled": no
 * working-tree changes, and HEAD at the very commit we made. Anything else —
 * new edits, a HEAD someone moved, a sha we could not read — skips the `rm`,
 * because leftover bytes are an annoyance and deleted work is not.
 */
export function isReclaimableAfterCarry({
  recheckKind,
  headSha,
  carrySha,
}: {
  recheckKind: CheckoutState['kind'];
  headSha: string | null;
  carrySha: string | null;
}): boolean {
  if (recheckKind !== 'clean' && recheckKind !== 'unpushed') return false;
  if (headSha === null || carrySha === null) return false;
  return headSha === carrySha;
}

/**
 * Is this the specific failure `git reset --mixed HEAD~1` produces when
 * `HEAD` has NO parent — a carry commit born on an empty remote, which makes
 * it the repository's root commit? (Pure.)
 *
 * Distinguishing this from a genuine reset failure matters: treating it as
 * `carry_failed` would destroy the freshly-provisioned Sprite and refuse a
 * promotion that the carry actually could have completed.
 */
export function isMissingParentCommitError(gitOutput: string): boolean {
  return /ambiguous argument|unknown revision/i.test(gitOutput);
}

/**
 * Inspect the project's OLD home on the machine Sprite. Promotion is only safe
 * when this returns `absent` or `clean`.
 *
 * Existence is probed separately (`test -e`) rather than inferred from `git
 * status` failing, because a failed status has two completely opposite
 * meanings — "there is no checkout here, nothing can be lost" and "the checkout
 * is there but we could not read it" — and guessing wrong in the second
 * direction destroys the user's uncommitted work.
 */
async function inspectMachineCheckout({
  machineId,
  project,
  actor,
  deps,
}: {
  machineId: string;
  project: MachineProjectRecord;
  actor: MachineActorContext;
  deps: PromoteProjectDeps;
}): Promise<CheckoutState> {
  const acquired = await deps.acquireMachineSandbox(machineId);
  if (!acquired.ok) return { kind: 'unknown', detail: `machine sandbox unavailable (${acquired.reason})` };
  const sandbox = await deps.reconnect(acquired.sandboxId);
  if (!sandbox) return { kind: 'unknown', detail: 'machine sandbox could not be reconnected' };

  let exists: boolean;
  try {
    const probe = await sandbox.runCommand({
      cmd: 'test',
      args: ['-e', project.path],
      timeoutMs: SANDBOX_TIMEOUT_MS,
      maxBytes: SANDBOX_MAX_OUTPUT_BYTES,
    });
    exists = probe.exitCode === 0;
  } catch (error) {
    return { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!exists) return { kind: 'absent' };

  // `-b` for the branch header: a clean tree still loses work if its commits
  // are not on a remote (see classifyCheckoutStatus).
  const status = await runGitInSandbox({
    cmd: 'git',
    args: ['status', '--porcelain', '-b'],
    cwd: project.path,
    ctx: buildActorCtx(`${machineId}:${project.name}`, actor),
    deps: buildGitDepsForMachine(machineId, deps),
  });
  if (!status.success) return { kind: 'unknown', detail: status.error ?? 'git status did not complete' };
  if (status.exitCode !== 0) return { kind: 'unknown', detail: status.stderr || status.stdout };

  return classifyCheckoutStatus(status.stdout);
}

/** Acquire + reconnect the OWNING Machine's Sprite, or `null` when either step fails. */
async function openMachineSandbox(machineId: string, deps: PromoteProjectDeps): Promise<ExecutableSandbox | null> {
  const acquired = await deps.acquireMachineSandbox(machineId);
  if (!acquired.ok) return null;
  return deps.reconnect(acquired.sandboxId);
}

/** The machine checkout's current HEAD sha, or `null` when it cannot be read (the reclaim guard then refuses). */
async function readMachineHeadSha({
  machineId,
  project,
  actor,
  deps,
}: {
  machineId: string;
  project: MachineProjectRecord;
  actor: MachineActorContext;
  deps: PromoteProjectDeps;
}): Promise<string | null> {
  const head = await runGitInSandbox({
    cmd: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: project.path,
    ctx: buildActorCtx(`${machineId}:${project.name}`, actor),
    deps: buildGitDepsForMachine(machineId, deps),
  });
  if (!head.success || head.exitCode !== 0) return null;
  const sha = head.stdout.trim();
  return sha.length > 0 ? sha : null;
}

type CarryOutcome =
  | { ok: true; carrySha: string | null }
  | { ok: false; reason: 'carry_failed' | 'carry_too_large'; detail: string };

/**
 * Carry the machine-side work onto the freshly-cloned project Sprite (issue
 * #2207) — the migration path out of the dirty/unpushed refusals.
 *
 * A GIT BUNDLE, moved as BYTES, is the mechanism, and both halves of that are
 * load-bearing:
 *
 *  • A bundle is a self-contained pack of REFS, so one mechanism carries both
 *    kinds of loss — uncommitted work (committed here first, un-committed again
 *    on the far side) and commits that never reached the remote.
 *  • It travels through `readFileToBuffer` → `writeFiles`, NOT through command
 *    stdout. Everything `runGitInSandbox` returns is screened for injection and
 *    truncated at `SANDBOX_MAX_OUTPUT_BYTES`; a patch that came back that way
 *    would apply SILENTLY CORRUPTED, which is the same data loss the refusal
 *    exists to prevent, wearing a success message.
 *
 * Runs AFTER the clone (it needs a repo to fetch into) and BEFORE the CAS, so a
 * failure is still a promotion that never happened: the caller kills the Sprite
 * and the machine checkout keeps everything (at worst plus a recoverable carry
 * commit).
 */
async function carryCheckoutToProjectSprite({
  machineId,
  project,
  projectName,
  state,
  actor,
  handle,
  deps,
}: {
  machineId: string;
  project: MachineProjectRecord;
  projectName: string;
  state: CheckoutState;
  actor: MachineActorContext;
  handle: MachineHandle;
  deps: PromoteProjectDeps;
}): Promise<CarryOutcome> {
  const ctx = buildActorCtx(`${machineId}:${projectName}`, actor);
  const machineGit = buildGitDepsForMachine(machineId, deps);
  const projectGit = buildGitDepsForHandle(handle, deps);

  const runOnMachine = (args: string[]) =>
    runGitInSandbox({ cmd: 'git', args, cwd: project.path, ctx, deps: machineGit });
  const runOnProject = (args: string[]) =>
    runGitInSandbox({ cmd: 'git', args, cwd: PROJECT_REPO_PATH, ctx, deps: projectGit });

  const failed = (step: string, result: Awaited<ReturnType<typeof runOnMachine>>): CarryOutcome => ({
    ok: false,
    reason: 'carry_failed',
    detail: `${step} failed: ${result.success ? result.stderr || result.stdout : (result.error ?? 'no detail')}`,
  });

  const branchStatus = await runOnMachine(['status', '--porcelain', '-b']);
  if (!branchStatus.success || branchStatus.exitCode !== 0) return failed('reading the checkout branch', branchStatus);
  const plan = buildCarryPlan({
    state,
    branchName: parseCheckoutBranchName(branchStatus.stdout),
    projectId: project.id,
  });

  if (plan.needsCommit) {
    const staged = await runOnMachine(['add', '-A']);
    if (!staged.success || staged.exitCode !== 0) return failed('staging the working tree', staged);
    // Identity supplied per-invocation: a Sprite has no configured committer,
    // and `--no-verify` because a repo's own hooks are not ours to run on a
    // commit the user did not ask for.
    const committed = await runOnMachine([
      '-c',
      `user.email=${actor.actorEmail}`,
      '-c',
      'user.name=PageSpace Carry',
      'commit',
      '--no-verify',
      '-m',
      CARRY_COMMIT_MESSAGE,
    ]);
    if (!committed.success || committed.exitCode !== 0) return failed('committing the working tree', committed);
  }

  if (plan.needsBranchCreate) {
    const branched = await runOnMachine(['branch', '-f', plan.branch, 'HEAD']);
    if (!branched.success || branched.exitCode !== 0) return failed('naming the detached HEAD', branched);
  }

  // Read AFTER the carry commit: this sha is what licenses the post-promotion
  // reclaim (`isReclaimableAfterCarry`).
  const carrySha = await readMachineHeadSha({ machineId, project, actor, deps });

  const bundled = await runOnMachine(['bundle', 'create', plan.bundlePath, '--all']);
  if (!bundled.success || bundled.exitCode !== 0) return failed('bundling the checkout', bundled);

  const machineSandbox = await openMachineSandbox(machineId, deps);
  if (!machineSandbox) {
    return { ok: false, reason: 'carry_failed', detail: 'the machine sandbox became unreachable mid-carry' };
  }

  // Size BEFORE the read — the read is what would OOM.
  let bytes: number | null;
  try {
    const sized = await machineSandbox.runCommand({
      cmd: 'stat',
      args: ['-c', '%s', plan.bundlePath],
      timeoutMs: SANDBOX_TIMEOUT_MS,
      maxBytes: SANDBOX_MAX_OUTPUT_BYTES,
    });
    bytes = sized.exitCode === 0 ? parseFileSizeBytes(sized.stdout) : null;
  } catch (error) {
    bytes = null;
    void error;
  }
  if (bytes === null) {
    return { ok: false, reason: 'carry_failed', detail: `could not measure the carry bundle at ${plan.bundlePath}` };
  }
  if (bytes > MAX_CARRY_BUNDLE_BYTES) {
    return {
      ok: false,
      reason: 'carry_too_large',
      detail:
        `The work to carry is ${bytes} bytes, over the ${MAX_CARRY_BUNDLE_BYTES}-byte carry limit. Push the ` +
        `branch (git -C ${project.path} push) and promote without a carry instead.`,
    };
  }

  let bundle: Buffer | null;
  try {
    bundle = await machineSandbox.readFileToBuffer({ path: plan.bundlePath });
  } catch (error) {
    return { ok: false, reason: 'carry_failed', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!bundle) return { ok: false, reason: 'carry_failed', detail: 'the carry bundle could not be read back' };

  try {
    await handle.writeFiles([{ path: plan.bundlePath, content: new Uint8Array(bundle) }]);
  } catch (error) {
    return { ok: false, reason: 'carry_failed', detail: error instanceof Error ? error.message : String(error) };
  }

  const fetched = await runOnProject(['fetch', plan.bundlePath, plan.fetchRefspec]);
  if (!fetched.success || fetched.exitCode !== 0) return failed('fetching the carried refs', fetched);

  const checkedOut = await runOnProject(['checkout', '-B', plan.branch, plan.checkoutTarget]);
  if (!checkedOut.success || checkedOut.exitCode !== 0) return failed('checking out the carried branch', checkedOut);

  if (plan.needsReset) {
    // `--mixed`, so the carry commit dissolves back into the working tree:
    // modified files return modified-but-unstaged, and files that were
    // untracked return untracked. The staged/unstaged split is the one thing
    // not preserved — everything comes back unstaged.
    const reset = await runOnProject(['reset', '--mixed', 'HEAD~1']);
    if (!reset.success || reset.exitCode !== 0) {
      // A checkout carried from an EMPTY remote makes the carry commit the
      // repo's ROOT commit — it has no parent, so `HEAD~1` does not resolve
      // and git refuses with "ambiguous argument … unknown revision" rather
      // than resetting. That is not a real failure, just a parent that
      // cannot exist; un-name the branch (HEAD becomes unborn) and `reset`
      // with no target, which unstages against the implicit empty tree —
      // the same "everything comes back uncommitted" outcome, for a commit
      // that has nothing to point "back" to.
      const resetOutput = reset.success ? reset.stderr || reset.stdout : '';
      if (!isMissingParentCommitError(resetOutput)) return failed('restoring the carried working tree', reset);
      const unref = await runOnProject(['update-ref', '-d', `refs/heads/${plan.branch}`]);
      if (!unref.success || unref.exitCode !== 0) return failed('clearing the root carry commit', unref);
      const rootReset = await runOnProject(['reset']);
      if (!rootReset.success || rootReset.exitCode !== 0) return failed('restoring the carried working tree', rootReset);
    }
  }

  // Best-effort cleanup of the staged bundle on both sides: it is a duplicate of
  // work that now lives in a repo, and neither copy is worth failing a completed
  // carry over.
  await Promise.allSettled([
    machineSandbox.runCommand({ cmd: 'rm', args: ['-f', plan.bundlePath], timeoutMs: SANDBOX_TIMEOUT_MS, maxBytes: SANDBOX_MAX_OUTPUT_BYTES }),
    handle.exec({ cmd: 'rm', args: ['-f', plan.bundlePath], timeoutMs: SANDBOX_TIMEOUT_MS, maxBytes: SANDBOX_MAX_OUTPUT_BYTES }),
  ]);

  return { ok: true, carrySha };
}

/**
 * Destroy a Sprite we provisioned but do NOT want to keep — identity-guarded so
 * a name-keyed kill can never destroy a replacement a concurrent promotion put
 * under the same name. See the identical helper in `machine-branches.ts`.
 */
/**
 * Did this clone fail because SOMETHING ELSE had already cloned into the
 * destination? (Pure.)
 *
 * `MachineHost.provision` is name-keyed and auto-resumes, and both racers of a
 * concurrent promotion derive the SAME deterministic `sessionKey` — so the two
 * calls can be holding handles to ONE physical Sprite, and the loser's clone
 * fails precisely because the winner already populated `PROJECT_REPO_PATH`.
 * That git message is the direct evidence of a shared Sprite; anything else
 * (auth failure, network, bad repo url) is our own clone failing on a Sprite
 * only we are using.
 *
 * It matters because the two mistakes are not symmetric. Killing a Sprite the
 * winner is mid-promotion on interrupts them, or leaves their row pointing at a
 * dead instance. Leaving a genuinely orphaned Sprite alive costs money until
 * `machine-orphan-reconcile` sweeps it. So this errs toward leaving it.
 */
export function isCloneBlockedByExistingCheckout(output: string): boolean {
  // Substring tests, not a `.*`-bridged alternation: git's stderr carries a
  // repo URL and path, both attacker-influencable, and `destination path .*
  // already exists` backtracks polynomially on repeated `destination path `.
  const text = output.toLowerCase();
  return (
    text.includes('already exists and is not an empty directory') ||
    (text.includes('destination path') && text.includes('already exists'))
  );
}

/**
 * Wait, briefly, for a concurrent promotion of this project to persist.
 *
 * Called only when our clone failed on an already-populated destination — the
 * one failure a racer sharing our name-keyed Sprite actually produces. If a
 * winner exists it is milliseconds from its CAS, so a short bounded poll
 * separates "someone is winning right now" from "this Sprite is a derelict from
 * an earlier failed attempt". Returns the winning row, or null if none appears.
 *
 * Bounded on purpose: waiting longer would hold a user-facing spawn open for a
 * winner that, by then, almost certainly does not exist.
 */
async function awaitPromotionWinner(
  projectId: string,
  deps: PromoteProjectDeps,
): Promise<MachineProjectRecord | null> {
  for (let attempt = 0; attempt <= PROMOTION_RACE_POLLS; attempt += 1) {
    const row = await deps.store.findById(projectId).catch(() => null);
    if (row?.sandboxId && row.sessionKey) return row;
    if (attempt < PROMOTION_RACE_POLLS) await deps.wait(PROMOTION_RACE_POLL_MS);
  }
  return null;
}

async function safeKillSprite(host: MachineHost, handle: MachineHandle): Promise<void> {
  try {
    await host.kill({ machineId: handle.machineId, expectedInstanceId: handle.spriteInstanceId });
  } catch {
    // best-effort — an unrecorded Sprite left alive bills with no row anywhere.
  }
}

/**
 * Reconcile after LOSING the promotion CAS (a concurrent promotion of the same
 * project persisted first).
 *
 * `MachineHost.provision` is name-keyed and auto-resumes, and both racers derive
 * the SAME `sessionKey`, so the two calls may be holding a handle to the very
 * same physical Sprite. In that case the Sprite must NOT be killed — it is the
 * one the winner recorded and is live. Only a genuinely different Sprite is safe
 * to tear down.
 */
async function reconcilePromotionCollision({
  deps,
  projectId,
  handle,
}: {
  deps: PromoteProjectDeps;
  projectId: string;
  handle: MachineHandle;
}): Promise<PromoteProjectResult> {
  const row = await deps.store.findById(projectId);
  if (row?.sandboxId && row.sessionKey) {
    // The INSTANCE, not just the name: a name is reused across re-creates, so
    // two concurrent provisions can hold two DIFFERENT VMs answering to the
    // same sandboxId. If ours is not the exact instance the winner persisted,
    // it is unrecorded and must die.
    //
    // This comparison is what makes that safe — NOT the kill's identity guard,
    // which only rejects a REPLACEMENT under the same name. A shared physical
    // VM carries the very instance id the guard checks for, so a kill of a
    // shared Sprite would succeed. The winner's Sprite survives here because
    // `isPersistedInstance` is true for it and we never call the kill.
    const isPersistedInstance =
      row.sandboxId === handle.machineId &&
      (row.spriteInstanceId ?? null) === (handle.spriteInstanceId ?? null);
    if (!isPersistedInstance) await safeKillSprite(deps.host, handle);
    return { ok: true, sandboxId: row.sandboxId, sessionKey: row.sessionKey, promoted: false, resumed: true, carried: false };
  }
  // Nobody actually won (the row vanished, or the CAS failed for a reason other
  // than a competing promotion) — our Sprite is unrecorded, so it can only be
  // killed, never left billing with nothing pointing at it.
  await safeKillSprite(deps.host, handle);
  return { ok: false, reason: 'error', detail: 'lost a concurrent project promotion race' };
}

/**
 * Reclaim the project's OLD checkout from the machine Sprite once the promotion
 * has been persisted. Best-effort: the promotion has already succeeded and the
 * project now lives elsewhere, so a leftover directory is a wasted-bytes
 * annoyance, never a correctness problem — whereas failing the whole promotion
 * over it would leave the user with a promoted project and an error message.
 *
 * CLEAN-TREE GATED by construction: this only ever runs on a path that already
 * confirmed the checkout clean (or absent) in THIS call — it is never reached
 * from the already-promoted early return, whose checkout state was never
 * inspected.
 */
async function reclaimMachineCheckout(machineId: string, path: string, deps: PromoteProjectDeps): Promise<boolean> {
  try {
    const acquired = await deps.acquireMachineSandbox(machineId);
    if (!acquired.ok) return false;
    const sandbox = await deps.reconnect(acquired.sandboxId);
    if (!sandbox) return false;
    const removed = await sandbox.runCommand({
      cmd: 'rm',
      args: ['-rf', path],
      timeoutMs: SANDBOX_TIMEOUT_MS,
      maxBytes: SANDBOX_MAX_OUTPUT_BYTES,
    });
    return removed.exitCode === 0;
  } catch {
    // best-effort — see above.
    return false;
  }
}

/**
 * Promote a project to its OWN Sprite, or reattach to it if it is already
 * promoted. Idempotent by (machineId, projectName): a second call returns the
 * same Sprite rather than provisioning a duplicate, and a promoted project whose
 * Sprite has VANISHED is transparently re-provisioned under the same
 * `sessionKey` and re-cloned.
 *
 * The name is free text and is normalized the same way `addProject` normalized
 * it before persisting, so whatever text created a project can also promote it.
 */
export async function promoteProject({
  machineId,
  projectName: requestedProjectName,
  actor,
  carryDirty = false,
  deps,
}: {
  machineId: string;
  projectName: string;
  actor: MachineActorContext;
  /**
   * Opt in to CARRYING the machine-side work across instead of refusing
   * (issue #2207). Off by default, and exposed only on the explicit operator
   * route — a project-scoped SPAWN must never silently relocate someone's
   * uncommitted work as a side effect of starting a terminal.
   */
  carryDirty?: boolean;
  deps: PromoteProjectDeps;
}): Promise<PromoteProjectResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'kill_switch_off' };

  const projectName = normalizeProjectName(requestedProjectName);
  const project = await deps.store.findByName(machineId, projectName);
  if (!project) return { ok: false, reason: 'project_not_found' };

  if (isPromotedProject(project) && project.sandboxId && project.sessionKey) {
    const handle = await deps.host.attach({ machineId: project.sandboxId });
    if (handle) {
      // Refresh on every reattach, not just first promotion — Claude Code OAuth
      // credentials rotate, so a one-time copy would drift stale (the same
      // reason `spawnBranch` re-copies on every reattach).
      await propagateClaudeCredential({ machineId, branchHandle: handle, resolveRootMachineHandle: deps.resolveRootMachineHandle });
      noteProjectStorage(deps.measureProjectStorage, { machineProjectId: project.id, machinePageId: machineId, handle });
      return { ok: true, sandboxId: handle.machineId, sessionKey: project.sessionKey, promoted: false, resumed: true, carried: false };
    }
    // Vanished — fall through and re-provision under the SAME session key.
  }

  // The refusal that makes promotion safe. Deliberately BEFORE the egress gate
  // and the provision: refusing costs the user nothing, whereas a Sprite
  // provisioned for a promotion we are about to refuse would have to be cleaned
  // up on a path that has no reason to exist.
  const checkout = await inspectMachineCheckout({ machineId, project, actor, deps });
  // `carryDirty` moves the work instead of refusing it (issue #2207) — but only
  // for the two states we can actually READ and bundle. `unknown` still refuses
  // below: carrying what we could not inspect would promote on a promise.
  const carrying = carryDirty && isCarryableState(checkout);
  if (checkout.kind === 'dirty' && !carrying) {
    return {
      ok: false,
      reason: 'dirty_checkout',
      detail:
        `The checkout at ${project.path} has uncommitted changes, and promoting this project would ` +
        `replace it with a fresh clone on its own sandbox — losing that work. Commit or discard the ` +
        `changes (git -C ${project.path} status) and retry, or promote with carryDirty to bring the ` +
        `work across.\n${checkout.detail}`,
    };
  }
  if (checkout.kind === 'unpushed' && !carrying) {
    return {
      ok: false,
      reason: 'unpushed_commits',
      detail:
        `The checkout at ${project.path} holds commits that are not on the remote, and promoting this ` +
        `project would replace it with a fresh clone of ${project.repoUrl} — losing them. Push the ` +
        `branch (git -C ${project.path} push) and retry, or promote with carryDirty to bring the ` +
        `commits across.\n${checkout.detail}`,
    };
  }
  if (checkout.kind === 'unknown') {
    return {
      ok: false,
      reason: 'dirty_check_failed',
      detail:
        `Could not verify that the checkout at ${project.path} is clean, so promotion was refused ` +
        `rather than risk discarding uncommitted work: ${checkout.detail}`,
    };
  }

  const enablement = await deps.checkFullEgressEnablement();
  if (!enablement.ok) return enablement;

  const sessionKey =
    project.sessionKey ?? deriveProjectSessionKey({ tenantId: actor.tenantId, machineId, projectName, secret: deps.secret });

  let handle: MachineHandle;
  try {
    handle = await deps.host.provision({ name: sessionKey, substrate: deps.substrate, options: deps.options });
  } catch (error) {
    return { ok: false, reason: 'provision_failed', detail: error instanceof Error ? error.message : String(error) };
  }

  const clone = await runGitInSandbox({
    cmd: 'git',
    args: ['clone', project.repoUrl, PROJECT_REPO_PATH],
    ctx: buildActorCtx(`${machineId}:${projectName}`, actor),
    deps: buildGitDepsForHandle(handle, deps),
  });
  if (!clone.success || clone.exitCode !== 0) {
    // A concurrent promotion of this SAME project may already have won — and,
    // because provision is name-keyed, may be sharing our exact Sprite, which
    // is precisely why our redundant clone failed ("destination path already
    // exists"). Reconcile before treating this as a failure.
    const row = await deps.store.findById(project.id);
    if (row?.sandboxId === handle.machineId && row.sessionKey) {
      return { ok: true, sandboxId: row.sandboxId, sessionKey: row.sessionKey, promoted: false, resumed: true, carried: false };
    }
    const detail = clone.success ? clone.stderr || clone.stdout : clone.error;
    // The winner may not have PERSISTED yet — provision is name-keyed, so the
    // Sprite we hold can be the very one their in-flight promotion is cloning
    // into while the row still reads unpromoted. Killing it here interrupts
    // them, or leaves their row pointing at a dead instance. The identity guard
    // does NOT save us: a SHARED Sprite has exactly the instance id we would
    // pass as `expectedInstanceId`, so the kill succeeds. Only a genuinely
    // different Sprite is protected by it. (Issue #2204 follow-up, F2.)
    //
    // But "the destination already exists" does NOT prove a live racer: a
    // previous promotion whose persist failed and whose best-effort kill also
    // failed leaves the same populated Sprite behind, with the row still
    // unpromoted. Trusting the message alone would make every retry resume that
    // unreferenced Sprite, fail the same clone, and leave it billing forever.
    // So the message only buys a BOUNDED WAIT for the supposed winner to
    // persist; if the row never claims a Sprite, ours is unreferenced and dies.
    //
    // WHY KILLING IS THE SAFE SIDE OF THIS BET. The two mistakes are not
    // symmetric, and not in the direction one might assume:
    //
    //  • Killing a Sprite a slow winner then CASes onto is RECOVERABLE. Their
    //    row points at a dead instance, and the next promotion attempt attaches,
    //    gets null, and re-provisions under the same deterministic session key
    //    (the `Vanished — fall through` path above). The system self-heals.
    //  • Leaving an unreferenced Sprite alive is PERMANENT. Nothing reclaims it:
    //    `machine-orphan-reconcile` works from the delete outbox (which needs a
    //    row to have existed and been deleted) and from rows stamped
    //    `teardownRequestedAt` — a Sprite that was provisioned but never
    //    persisted has neither, so no sweep will ever find it. It bills forever.
    const winner = isCloneBlockedByExistingCheckout(detail ?? '')
      ? await awaitPromotionWinner(project.id, deps)
      : null;
    if (winner?.sandboxId && winner.sessionKey) {
      return { ok: true, sandboxId: winner.sandboxId, sessionKey: winner.sessionKey, promoted: false, resumed: true, carried: false };
    }
    await safeKillSprite(deps.host, handle);
    return { ok: false, reason: 'clone_failed', detail };
  }

  // The carry sits between the clone (which it needs) and the CAS (which it must
  // precede): until the row points here, a failed carry is a promotion that
  // never happened, and the only cleanup owed is the Sprite.
  let carrySha: string | null = null;
  if (carrying) {
    const carried = await carryCheckoutToProjectSprite({
      machineId,
      project,
      projectName,
      state: checkout,
      actor,
      handle,
      deps,
    });
    if (!carried.ok) {
      await safeKillSprite(deps.host, handle);
      return { ok: false, reason: carried.reason, detail: carried.detail };
    }
    carrySha = carried.carrySha;
  }

  let persisted: boolean;
  try {
    persisted = await deps.store.promote({
      id: project.id,
      // The row must still hold exactly what we read: NULL for a first
      // promotion, or the vanished Sprite's name when re-provisioning.
      previousSandboxId: project.sandboxId,
      sessionKey,
      sandboxId: handle.machineId,
      // WHICH VM this is — `sandboxId` is only the (reused) name.
      spriteInstanceId: handle.spriteInstanceId ?? null,
      now: deps.now(),
    });
  } catch (error) {
    // ANY failure to record the promotion (connection blip, aborted tx) would
    // otherwise leave the Sprite we just provisioned ALIVE with no row pointing
    // at it — billing forever, unreachable. Kill it: the row is the only thing
    // that could ever have found it again. The NEXT promotion attempt re-derives
    // the same deterministic `sessionKey`, so nothing is lost by tearing this
    // one down. (Same rule `spawnBranch` applies on its own save failure.)
    await safeKillSprite(deps.host, handle);
    return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!persisted) return reconcilePromotionCollision({ deps, projectId: project.id, handle });

  // Ordered AFTER the CAS on purpose: until the row points at this Sprite, a
  // racer that finds no promoted row would conclude our Sprite is its own
  // redundant one and kill it. Everything below is best-effort follow-up work
  // on a promotion that has already succeeded.
  await propagateClaudeCredential({ machineId, branchHandle: handle, resolveRootMachineHandle: deps.resolveRootMachineHandle });
  if (checkout.kind === 'clean' || carrying) {
    // Re-inspected IMMEDIATELY before the rm: the gate above ran before the
    // slow provision+clone, and a terminal or tool may have written into the
    // old checkout in that window. Anything but a fresh `clean` skips the
    // reclaim — a leftover directory is an annoyance; deleting work someone
    // just wrote is a loss. (The window between this recheck and the rm is
    // milliseconds; the one it closes was the whole clone.)
    //
    // A CARRIED checkout can never come back `clean` — we committed the work
    // there, so it is clean-but-one-ahead — hence its own predicate, which asks
    // the equivalent question: is this still exactly the tree we bundled?
    const recheck = await inspectMachineCheckout({ machineId, project, actor, deps });
    const reclaimable = carrying
      ? isReclaimableAfterCarry({
          recheckKind: recheck.kind,
          headSha: await readMachineHeadSha({ machineId, project, actor, deps }),
          carrySha,
        })
      : recheck.kind === 'clean';
    if (reclaimable) {
      const reclaimed = await reclaimMachineCheckout(machineId, project.path, deps);
      // The ROOT just got smaller, and its last persisted measurement still
      // includes the bytes we removed. Until some unrelated root operation
      // refreshes it, storage reconciliation bills those bytes on the machine
      // AND on the new project Sprite — indefinitely, if nothing else touches
      // the root. Re-measure it here, on the one path that knows it shrank.
      // (Issue #2204 follow-up, F12.) Best-effort, like every other follow-up
      // step below the CAS.
      if (reclaimed) noteRootStorageAfterReclaim(machineId, deps);
    }
  }
  // Measured right after the clone that wrote the bulk of this Sprite's
  // footprint — the one moment its bytes are guaranteed non-trivial.
  noteProjectStorage(deps.measureProjectStorage, { machineProjectId: project.id, machinePageId: machineId, handle });

  return { ok: true, sandboxId: handle.machineId, sessionKey, promoted: true, resumed: false, carried: carrying };
}
