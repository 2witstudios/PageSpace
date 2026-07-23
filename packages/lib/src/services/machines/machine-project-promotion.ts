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

export type PromoteProjectDenialReason =
  | 'kill_switch_off'
  | 'project_not_found'
  /** The machine-side checkout has uncommitted work — promoting would destroy it. */
  | 'dirty_checkout'
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

type CheckoutState =
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
  // `## name...upstream` is the only shape that names a remote ref. Anything
  // else — `## name`, `## HEAD (no branch)` — has nothing to be reproduced from.
  if (!branch.includes('...')) {
    return { kind: 'unpushed', detail: `no upstream branch to reproduce this checkout from (${branch})` };
  }
  return { kind: 'clean' };
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
    return { ok: true, sandboxId: row.sandboxId, sessionKey: row.sessionKey, promoted: false, resumed: true };
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
  deps,
}: {
  machineId: string;
  projectName: string;
  actor: MachineActorContext;
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
      return { ok: true, sandboxId: handle.machineId, sessionKey: project.sessionKey, promoted: false, resumed: true };
    }
    // Vanished — fall through and re-provision under the SAME session key.
  }

  // The refusal that makes promotion safe. Deliberately BEFORE the egress gate
  // and the provision: refusing costs the user nothing, whereas a Sprite
  // provisioned for a promotion we are about to refuse would have to be cleaned
  // up on a path that has no reason to exist.
  const checkout = await inspectMachineCheckout({ machineId, project, actor, deps });
  if (checkout.kind === 'dirty') {
    return {
      ok: false,
      reason: 'dirty_checkout',
      detail:
        `The checkout at ${project.path} has uncommitted changes, and promoting this project would ` +
        `replace it with a fresh clone on its own sandbox — losing that work. Commit or discard the ` +
        `changes (git -C ${project.path} status) and retry.\n${checkout.detail}`,
    };
  }
  if (checkout.kind === 'unpushed') {
    return {
      ok: false,
      reason: 'unpushed_commits',
      detail:
        `The checkout at ${project.path} holds commits that are not on the remote, and promoting this ` +
        `project would replace it with a fresh clone of ${project.repoUrl} — losing them. Push the ` +
        `branch (git -C ${project.path} push) and retry.\n${checkout.detail}`,
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
      return { ok: true, sandboxId: row.sandboxId, sessionKey: row.sessionKey, promoted: false, resumed: true };
    }
    const detail = clone.success ? clone.stderr || clone.stdout : clone.error;
    // The winner may not have PERSISTED yet — provision is name-keyed, so the
    // Sprite we hold can be the very one their in-flight promotion is cloning
    // into while the row still reads unpromoted. Killing it here interrupts
    // them, or leaves their row pointing at a dead instance. The identity guard
    // does NOT save us: a SHARED Sprite has exactly the instance id we would
    // pass as `expectedInstanceId`, so the kill succeeds. Only a genuinely
    // different Sprite is protected by it. (Issue #2204 follow-up, F2.)
    if (!isCloneBlockedByExistingCheckout(detail ?? '')) {
      await safeKillSprite(deps.host, handle);
    }
    return { ok: false, reason: 'clone_failed', detail };
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
  if (checkout.kind === 'clean') {
    // Re-inspected IMMEDIATELY before the rm: the gate above ran before the
    // slow provision+clone, and a terminal or tool may have written into the
    // old checkout in that window. Anything but a fresh `clean` skips the
    // reclaim — a leftover directory is an annoyance; deleting work someone
    // just wrote is a loss. (The window between this recheck and the rm is
    // milliseconds; the one it closes was the whole clone.)
    const recheck = await inspectMachineCheckout({ machineId, project, actor, deps });
    if (recheck.kind === 'clean') {
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

  return { ok: true, sandboxId: handle.machineId, sessionKey, promoted: true, resumed: false };
}
