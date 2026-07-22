/**
 * Machine Branches: spawn / attach / kill / list branch-terminals of a
 * Project (IO, dependency-injected where it touches the sandbox/DB).
 *
 * "A terminal IS a worktree — an isolated checked-out branch — and each runs
 * in its OWN isolated container" (tasks/terminal.md). On Sprites the
 * container IS the Sprite, so a branch-terminal is a SEPARATE Sprite from the
 * one its owning Machine (`machineId`) or any other branch of the same
 * Project uses — never a shared filesystem, never a git worktree on a shared
 * checkout. `spawnBranch` provisions that Sprite directly through the
 * `MachineHost` seam (`../sandbox/machine-host.ts`), under a name derived by
 * `deriveBranchSessionKey` — distinct per (tenant, machine, project, branch),
 * so two branches of one project always resolve to two distinct Sprites.
 *
 * Cloning reuses `runGitInSandbox` (the same hardened git execution path the
 * agent's `git_clone` tool and the Projects tier's `addProject` use): the
 * acting user's GitHub token is fetched per-call and injected into the child
 * process env for that one command only, via the existing one-shot
 * credential helper — never written to argv, disk, or persisted git config.
 * Unlike Projects (which acquires the OWNING Machine's persistent session),
 * a branch-terminal's git commands run against the Sprite THIS call just
 * provisioned/attached — `acquireSandbox`/`reconnect` below are bound
 * directly to that handle, never to a page-keyed Machine lookup.
 */

import { createId } from '@paralleldrive/cuid2';
import type { SubscriptionTier } from '../subscription-utils';
import { runGitInSandbox, type GitSandboxRunDeps } from '../sandbox/git-tool-runners';
import type { SandboxActorContext, SandboxQuotaDeps } from '../sandbox/tool-runners';
import { SANDBOX_ROOT } from '../sandbox/sandbox-paths';
import { SANDBOX_MAX_OUTPUT_BYTES } from '../sandbox/execution-policy';
import type { MachineHost, MachineHandle, MachineSubstrateSpec } from '../sandbox/machine-host';
import { adaptMachineHandleToExecutableSandbox } from '../sandbox/sandbox-client/machine-host-adapter';
import type { SandboxCreateOptions } from '../sandbox/sandbox-options';
import type { FullEgressEnablement, FullEgressDenialReason } from '../sandbox/containment';
import type { CodeExecutionAuditInput } from '../sandbox/audit';
import { deriveBranchSessionKey, normalizeBranchName } from './branch-session';
import { normalizeProjectName } from './project-paths';
import { isUniqueViolation, type MachineBranchStore, type MachineBranchRecord } from './machine-branches-store';

// Defined in sandbox-paths.ts (see there for why); imported for local use and
// re-exported for existing callers.
import { BRANCH_REPO_PATH } from '../sandbox/sandbox-paths';
export { BRANCH_REPO_PATH };

/**
 * Where Claude Code writes its OAuth credential/config on a Sprite's own
 * persistent filesystem. A branch-terminal is a SEPARATE Sprite from its
 * owning Machine (see module doc), so it never inherits whatever the user
 * logged into on the root Sprite — these paths are copied across explicitly,
 * see `propagateClaudeCredential` below.
 */
const CLAUDE_CREDENTIALS_PATH = '/home/sprite/.claude/.credentials.json';
const CLAUDE_CONFIG_PATH = '/home/sprite/.claude.json';

export type SpawnBranchDenialReason =
  | 'kill_switch_off'
  | 'project_not_found'
  | 'provision_failed'
  | 'clone_failed'
  | 'checkout_failed'
  | 'error';

export interface MachineActorContext {
  userId: string;
  tenantId: string;
  actorEmail: string;
  actorDisplayName?: string;
  tier: SubscriptionTier;
}

/** The minimal slice of the Projects store Branches needs — just enough to resolve a project's `repoUrl`. */
export interface MachineBranchProjectLookup {
  findByName(machineId: string, name: string): Promise<{ repoUrl: string } | null>;
}

export interface MachineBranchesDeps {
  store: MachineBranchStore;
  projectStore: MachineBranchProjectLookup;
  isEnabled: () => boolean;
  now: () => Date;
  /** The provider-neutral Sprite lifecycle seam — see `../sandbox/machine-host.ts`. */
  host: MachineHost;
  substrate: MachineSubstrateSpec;
  options: SandboxCreateOptions;
  /** Server-held secret for session-key derivation (same secret as machine-session-manager.ts). */
  secret: string;
  /** REQUIRED full-egress enablement gate — a branch-terminal's Sprite runs open egress, same as a human Terminal. */
  checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  resolveGitHubToken: (userId: string) => Promise<string | null>;
  /**
   * Live handle to the OWNING Machine's own persistent Sprite (never a
   * branch's) — the source a branch-terminal's Claude Code credential is
   * copied from. `null` when the root Machine has no live session yet (the
   * user hasn't opened its Terminal / isn't logged into Claude Code there),
   * which `propagateClaudeCredential` treats as a graceful no-op.
   */
  resolveRootMachineHandle: (machineId: string) => Promise<MachineHandle | null>;
  quota: SandboxQuotaDeps;
  buildEnv: () => Record<string, string>;
  audit: (input: CodeExecutionAuditInput) => Promise<void>;
  screenOutput?: (text: string) => Promise<string>;
  /**
   * Optional opportunistic storage-measurement seam (issue #2204 phase 3).
   * While this branch's Sprite is ALREADY awake for a spawn/clone or a reattach,
   * capture its used bytes onto its own `machine_branches` row so the storage
   * reconcile can bill them to the OWNING Machine page without ever waking a
   * hibernating Sprite. Best-effort and fire-and-forget — a failure must never
   * affect the spawn; omitting it disables measurement (the reconcile then bills
   * this branch the conservative never-measured 0 floor).
   */
  measureBranchStorage?: (input: BranchStorageMeasurement) => Promise<void>;
}

/** Input to the branch storage-measurement seam — the branch's own row plus its attribution key. */
export interface BranchStorageMeasurement {
  /** The `machine_branches` row the measurement is persisted on. */
  machineBranchId: string;
  /** The owning Machine page the measured bytes bill to (machine-storage-attribution.ts). */
  machinePageId: string;
  /** The branch Sprite's ALREADY-LIVE handle — measurement never provisions or wakes one. */
  handle: MachineHandle;
}

/**
 * Fire the optional storage-measurement seam for a branch Sprite we currently
 * hold awake. Deliberately NOT awaited: measurement is a background billing
 * concern (throttled to at most one `du` per window inside the seam), and the
 * user-facing spawn/attach must not wait on it or fail with it.
 */
function noteBranchStorage(
  measure: ((input: BranchStorageMeasurement) => Promise<void>) | undefined,
  input: BranchStorageMeasurement,
): void {
  if (!measure) return;
  void measure(input).catch(() => {
    /* Best-effort: the seam already logs; a spawn/attach must never fail on it. */
  });
}

export type SpawnBranchResult =
  /**
   * `branchName` is the NORMALIZED name — what was persisted and checked out,
   * which the caller must echo back rather than the text the user typed.
   *
   * `createdNew` says whether the branch was CREATED off the clone's default
   * HEAD (no `origin/<branchName>` existed) or checked out from an existing
   * upstream branch. It matters because normalization can rewrite a name that
   * DOES exist upstream into one that doesn't (`_wip` → `wip`: git allows a
   * leading `_`, our narrower charset does not), and git's fallback then hands
   * the user a new empty branch. Reporting it makes that outcome visible rather
   * than silent. `undefined` on a pure reattach, where nothing was cloned.
   */
  | { ok: true; sandboxId: string; branchName: string; resumed: boolean; createdNew?: boolean }
  | { ok: false; reason: SpawnBranchDenialReason | FullEgressDenialReason; detail?: string };

/**
 * Exported so other Machine-scope callers that build a `SandboxActorContext`
 * for a branch-terminal op (e.g. `machine-git-blob-runtime.ts`) share this one
 * definition instead of re-typing the same literal — a future required field
 * on `SandboxActorContext` then only needs fixing here.
 */
export function buildActorCtx(scopeKey: string, actor: MachineActorContext): SandboxActorContext {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    driveId: undefined,
    // See module doc: a branch-terminal op has no conversation, so this
    // opaque scope key (ignored by the acquireSandbox closure below) just
    // satisfies the field.
    conversationId: scopeKey,
    actorEmail: actor.actorEmail,
    actorDisplayName: actor.actorDisplayName,
    tier: actor.tier,
  };
}

/**
 * Build `runGitInSandbox` deps bound directly to an already-provisioned
 * `MachineHandle` — no page-keyed acquire/reconnect lookup, because Branches
 * (unlike Projects) hold the live handle from the moment they provision it.
 */
function buildGitDepsForHandle(handle: MachineHandle, deps: MachineBranchesDeps): GitSandboxRunDeps {
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

/** `createdNew`: no `origin/<branch>` existed, so the branch was created off the clone's default HEAD. */
type CloneResult =
  | { ok: true; createdNew: boolean }
  | { ok: false; reason: 'clone_failed' | 'checkout_failed'; detail?: string };

async function cloneAndCheckoutBranch({
  handle,
  repoUrl,
  branchName,
  scopeKey,
  actor,
  deps,
}: {
  handle: MachineHandle;
  repoUrl: string;
  branchName: string;
  scopeKey: string;
  actor: MachineActorContext;
  deps: MachineBranchesDeps;
}): Promise<CloneResult> {
  const ctx = buildActorCtx(scopeKey, actor);
  const gitDeps = buildGitDepsForHandle(handle, deps);

  const clone = await runGitInSandbox({ cmd: 'git', args: ['clone', repoUrl, BRANCH_REPO_PATH], ctx, deps: gitDeps });
  if (!clone.success) return { ok: false, reason: 'clone_failed', detail: clone.error };
  if (clone.exitCode !== 0) return { ok: false, reason: 'clone_failed', detail: clone.stderr || clone.stdout };

  // Prefer an existing remote branch; fall back to a fresh local branch off
  // the clone's default HEAD when it doesn't exist upstream yet.
  const checkoutExisting = await runGitInSandbox({
    cmd: 'git',
    args: ['checkout', '-b', branchName, `origin/${branchName}`],
    cwd: BRANCH_REPO_PATH,
    ctx,
    deps: gitDeps,
  });
  if (checkoutExisting.success && checkoutExisting.exitCode === 0) return { ok: true, createdNew: false };

  const checkoutNew = await runGitInSandbox({
    cmd: 'git',
    args: ['checkout', '-b', branchName],
    cwd: BRANCH_REPO_PATH,
    ctx,
    deps: gitDeps,
  });
  if (!checkoutNew.success) return { ok: false, reason: 'checkout_failed', detail: checkoutNew.error };
  if (checkoutNew.exitCode !== 0) {
    return { ok: false, reason: 'checkout_failed', detail: checkoutNew.stderr || checkoutNew.stdout };
  }
  return { ok: true, createdNew: true };
}

/**
 * Hard cap on how long a single `propagateClaudeCredential` call may run.
 * Every direct caller in this file (`spawnBranch`'s two success paths,
 * `attachBranch`) awaits it inline on a real HTTP response, and the
 * realtime PTY bridge's own bound (`agent-terminal-access.ts`'s
 * `withTimeout`) only covers ITS OWN wrapper around this call, not a
 * guarantee this function makes for its OTHER callers — a hibernating root
 * Sprite's fs read/write can take up to the Sprite fs API's 30s timeout,
 * with one retry (~60s worst case), and an unbounded copy would hang a
 * branch-attach HTTP response on that (caught in review). The timer is
 * always cleared, and the underlying work keeps running past the bound
 * rather than being cancelled — a slow copy still lands, just too late to
 * have been waited on by THIS call.
 */
const CREDENTIAL_COPY_TIMEOUT_MS = 5_000;

/**
 * `MachineHandle.exec`'s underlying Sprite runner only installs its SIGKILL
 * wall-clock timer when `timeoutMs` is explicitly supplied (`sprites.ts`:
 * the kill timer is conditional on `timeoutMs && timeoutMs > 0`) — an exec
 * call with none is genuinely unbounded at the transport level, regardless
 * of `CREDENTIAL_COPY_TIMEOUT_MS` above (that only stops THIS function's
 * caller from waiting; it does not touch the exec itself). Without an
 * explicit bound, a wedged `rm`/`mv` on a cold/unreachable Sprite would
 * never be killed, leaking its process/socket on every such attach (caught
 * in review). Every housekeeping exec in this file passes this.
 */
function housekeepingExecArgs(cmd: string, args: string[]): { cmd: string; args: string[]; timeoutMs: number; maxBytes: number } {
  return { cmd, args, timeoutMs: CREDENTIAL_COPY_TIMEOUT_MS, maxBytes: SANDBOX_MAX_OUTPUT_BYTES };
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * Latest `propagateClaudeCredential` call number issued per branch Sprite
 * machineId — see the staleness check before each `mv` below for why.
 *
 * PROCESS-LOCAL ONLY: `spawnBranch`/`attachBranch` (this file, called from
 * `apps/web`) and the realtime PTY bridge's `refreshBranchCredential`
 * (`apps/realtime/src/index.ts`) are TWO SEPARATE PROCESSES, each with its
 * own copy of this in-memory Map — a call in one process cannot see, or
 * detect staleness against, an overlapping call in the other (caught in
 * review). This still closes the WITHIN-process race (e.g. two nearly
 * simultaneous requests on the same server), and the temp-file path below
 * is made globally unique regardless of process, so an inter-process race
 * can never corrupt the OTHER process's in-flight temp file — but an
 * inter-process race CAN still end with an older credential's `mv` landing
 * last. Accepted: full cross-process mutual exclusion would need a
 * database-backed lock or a version marker persisted on the Sprite's own
 * filesystem, which is disproportionate for a background sync where every
 * single refresh is already best-effort and self-heals on the next
 * reattach in either process.
 */
const latestCredentialCopyGeneration = new Map<string, number>();

/**
 * Copy Claude Code's OAuth credential (and config, if present) from the root
 * Machine's Sprite into a branch-terminal's freshly provisioned/attached one.
 * Each file is copied independently and skipped when the root read comes
 * back empty — most commonly because the user hasn't run `claude` there yet
 * — so a branch-terminal always ends up usable even with no credential to
 * copy.
 *
 * Deliberately does NOT delete an existing branch-side copy on an empty
 * root read, even though that read coming back empty could also mean an
 * explicit `claude logout` on the root (a tempting "propagate the
 * revocation" behavior — tried and reverted, see review history). The
 * driver's `readFile` maps EVERY read failure to the same `null` a missing
 * file produces (`sprites.ts`'s `readFileToBuffer`: "a missing file (or ANY
 * read failure after a wake retry) resolves to null") — there is no way,
 * from this signal alone, to tell "confirmed gone" apart from "root Sprite
 * was briefly unreachable." Deleting on that ambiguous signal would risk
 * destroying a branch's perfectly valid, working credential on a transient
 * hiccup — strictly worse than the staleness this would have closed.
 *
 * Best-effort: any failure (root Sprite unreachable mid-copy, etc.) is
 * swallowed rather than failing the spawn/attach it's called from, AND the
 * whole call is bounded by `CREDENTIAL_COPY_TIMEOUT_MS` so a slow/hibernating
 * Sprite can't hang the caller's response. A branch without the credential
 * still works, it just needs its own `claude` login.
 *
 * Exported for reuse by the realtime agent-terminal PTY bridge
 * (`apps/realtime/src/index.ts`'s `resolveAgentTerminalSandbox`), which is
 * the OTHER place a branch's Sprite gets attached to for real use (opening or
 * reattaching to its Claude agent terminal) — `spawnBranch`/`attachBranch`
 * alone only cover branch creation and the navigator's explicit attach API,
 * neither of which the realtime PTY path calls.
 */
export async function propagateClaudeCredential({
  machineId,
  branchHandle,
  resolveRootMachineHandle,
}: {
  machineId: string;
  branchHandle: MachineHandle;
  resolveRootMachineHandle: (machineId: string) => Promise<MachineHandle | null>;
}): Promise<void> {
  // This call's own generation number for this branch Sprite. `withTimeout`
  // deliberately does NOT cancel the underlying work when its bound elapses
  // — it keeps running in the background so a slow copy still lands rather
  // than being aborted. But that means an OVERLAPPING call that read an
  // OLDER root credential and then stalled could otherwise finish LATER and
  // `mv` its stale temp file over a destination a faster, more recent call
  // already updated with a NEWER (rotated) credential — clobbering it
  // (caught in review). Checking, right before each `mv`, whether a NEWER
  // call has since started for this same branch Sprite — and skipping the
  // rename if so — is what prevents that: a self-contained per-file check
  // rather than a lock that would need its own release/backstop logic (and
  // the "what if the thing holding it never finishes" risk that comes with
  // one).
  const generation = (latestCredentialCopyGeneration.get(branchHandle.machineId) ?? 0) + 1;
  latestCredentialCopyGeneration.set(branchHandle.machineId, generation);

  await withTimeout(
    (async () => {
      try {
        const rootHandle = await resolveRootMachineHandle(machineId);
        if (!rootHandle) return;

        for (const path of [CLAUDE_CREDENTIALS_PATH, CLAUDE_CONFIG_PATH]) {
          const content = await rootHandle.readFile({ path });
          if (!content) continue;
          // Write to a TEMP path, then atomically rename it onto the real
          // destination — never delete-then-write or write-then-chmod
          // directly against the live path. Both were tried and reverted:
          // write-then-chmod left a window where the fresh secret sat at
          // the OLD (possibly permissive) mode until the chmod resolved,
          // and a slow/stuck chmod could leave that window open past
          // whatever bound the caller waited on. Delete-then-write closed
          // THAT window but opened a worse one: if the write that follows
          // the delete then fails (or the caller's timeout elapses in
          // between), the branch is left with NO credential at all, even
          // though it had a perfectly valid one moments before — a
          // regression on exactly the transient Sprite/FS hiccups this
          // best-effort path exists to tolerate (caught in review, twice).
          //
          // `writeFiles`' `mode` reliably applies to a genuine CREATION —
          // and `mv` on the same filesystem is atomic: the destination is
          // either the OLD valid credential or the NEW one, NEVER
          // wrong-permission or briefly absent in between. If anything
          // fails before the rename, the live file at `path` is completely
          // untouched.
          // Suffixed with a globally unique id — never shared with an
          // overlapping call for the same branch Sprite, WITHIN this
          // process or across the OTHER process that also calls this
          // function (`apps/web`'s spawnBranch/attachBranch vs.
          // `apps/realtime`'s refreshBranchCredential — see the doc comment
          // on `latestCredentialCopyGeneration`, which is process-local and
          // therefore cannot be used to key the temp path). A fixed temp
          // name was tried and reverted: when an older call's stale cleanup
          // (below) ran after a newer, overlapping call had already written
          // ITS OWN content to that same shared path, the older cleanup
          // deleted the newer call's temp file out from under it, making
          // the newer (correct) refresh fail its own `mv` (caught in
          // review, twice — once for the intra-process case, once for the
          // inter-process one this id fixes). A globally unique path means
          // no two overlapping calls, from either process, ever touch the
          // same temp file, so one's cleanup can never disturb another's
          // in-progress write.
          const tempPath = `${path}.tmp.${createId()}`;
          // Still clear it first — vanishingly unlikely to collide with a
          // stale leftover (a cuid2 id, not a small counter), but a
          // crashed-and-restarted process could in principle still hand out
          // the same id twice given a broken/predictable random source, and
          // clearing costs nothing extra. Writing to an ALREADY-EXISTING
          // temp path would be an overwrite, not a
          // creation, silently keeping whatever (possibly permissive) mode
          // that stale file already had. Checked, not fire-and-forget: if
          // the clear itself fails, abort BEFORE writing rather than assume
          // the temp path is now clear — still safe either way, since
          // nothing has touched the live file yet.
          const clearTemp = await branchHandle.exec(housekeepingExecArgs('rm', ['-f', tempPath]));
          if (clearTemp.exitCode !== 0) {
            throw new Error(`rm -f ${tempPath} failed: exit ${clearTemp.exitCode}`);
          }
          await branchHandle.writeFiles([{ path: tempPath, content, mode: 0o600 }]);

          // A NEWER call already started for this branch Sprite while this
          // one was working — it will (or already did) land more current
          // data, so abandon this stale attempt rather than risk this one's
          // `mv` clobbering it once it finally gets here.
          //
          // KNOWN, ACCEPTED RESIDUAL WINDOW (raised in review, twice): this
          // check happens BEFORE the `mv` below, not atomically with it. A
          // newer call could still start, read a rotated credential, and
          // complete its OWN `mv` entirely within the time this call's own
          // `mv` (checked as still-current a moment ago) takes to actually
          // land — landing this stale `mv` last and overwriting the fresher
          // one anyway. Closing that fully would need either an atomic
          // compare-and-swap primitive this filesystem abstraction doesn't
          // expose, or a synchronous per-branch mutex serializing every
          // `mv` (which would then queue an unrelated caller's response
          // behind however long a DIFFERENT in-flight refresh's Sprite I/O
          // takes — reintroducing the unbounded-latency problem this
          // design exists to avoid). The impact is staleness, not exposure:
          // worst case, the branch keeps using an old-but-still-valid
          // token a little longer, and self-heals on the next reattach in
          // either process — consistent with every other best-effort
          // guarantee in this function. Deliberately not chased further.
          if (latestCredentialCopyGeneration.get(branchHandle.machineId) !== generation) {
            await branchHandle.exec(housekeepingExecArgs('rm', ['-f', tempPath]));
            return;
          }

          const move = await branchHandle.exec(housekeepingExecArgs('mv', [tempPath, path]));
          if (move.exitCode !== 0) {
            // Best-effort cleanup of the orphaned temp file (itself already
            // 0o600, so leaving it behind on a rare failure is a harmless
            // leftover, not an exposure) — the live file at `path` was never
            // touched by this attempt either way.
            await branchHandle.exec(housekeepingExecArgs('rm', ['-f', tempPath]));
            throw new Error(`mv ${tempPath} -> ${path} failed: exit ${move.exitCode}`);
          }
        }
      } catch {
        // best-effort — see doc comment above.
      }
    })(),
    CREDENTIAL_COPY_TIMEOUT_MS,
  );
}

/**
 * Destroy a Sprite we provisioned but do NOT want to keep (a failed clone, or a
 * redundant one that lost a provisioning race), best-effort and identity-guarded.
 *
 * Takes the live `handle` rather than a bare name because the kill is name-keyed
 * and names are REUSED across re-creates: passing `handle.spriteInstanceId` as
 * the guard ensures we destroy the VM WE just provisioned, never a replacement a
 * concurrent spawn put under the same name. Swallows any error — an unrecorded
 * Sprite left alive is billing with no row anywhere (no trigger, no reclaim), so
 * killing it is the only cleanup available; if that fails too we can do no
 * better, and the original failure is what the caller reports.
 */
async function safeKillSprite(host: MachineHost, handle: MachineHandle): Promise<void> {
  try {
    await host.kill({ machineId: handle.machineId, expectedInstanceId: handle.spriteInstanceId });
  } catch {
    // best-effort — see above.
  }
}

/**
 * Reconcile after losing a provisioning collision (a concurrent `spawnBranch`
 * call for the same branch beat us to persisting a row). `MachineHost.provision`
 * is name-keyed and auto-resumes ("same name, same filesystem" — see
 * `../sandbox/machine-host.ts`), so two concurrent calls deriving the same
 * session key can both end up holding a handle to the SAME physical Sprite —
 * in that case the Sprite must NOT be killed, since it's the one the winner
 * already recorded and is live. Only a genuinely distinct (or absent) tracked
 * Sprite is safe to tear down.
 */
async function reconcileProvisionCollision({
  deps,
  machineId,
  projectName,
  branchName,
  handle,
}: {
  deps: MachineBranchesDeps;
  machineId: string;
  projectName: string;
  branchName: string;
  handle: MachineHandle;
}): Promise<{ ok: true; sandboxId: string; branchName: string; resumed: true } | { row: MachineBranchRecord | null }> {
  const row = await deps.store.findByName(machineId, projectName, branchName);
  if (row && row.sandboxId === handle.machineId) {
    return { ok: true, sandboxId: row.sandboxId, branchName: row.branchName, resumed: true };
  }
  await safeKillSprite(deps.host, handle);
  return { row };
}

/**
 * Spawn (or resume) a branch-terminal: an isolated Sprite with `branchName`
 * checked out from the named Project. Idempotent by (machineId,
 * projectName, branchName) — a second call reattaches to the same Sprite
 * (or transparently re-provisions under the same name if it has since
 * vanished) instead of creating a duplicate.
 *
 * `branchName` is free text: it is NORMALIZED here (not rejected — see
 * `normalizeBranchName`), and the normalized form is what gets checked out,
 * hashed into the session key, persisted, and returned. This is the
 * authoritative normalization point; any future client-side live preview would
 * be a convenience, never the source of truth.
 */
export async function spawnBranch({
  machineId,
  projectName: requestedProjectName,
  branchName: requestedBranchName,
  actor,
  deps,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
  actor: MachineActorContext;
  deps: MachineBranchesDeps;
}): Promise<SpawnBranchResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'kill_switch_off' };

  // Both names are free text. `addProject` persists the CANONICAL project name,
  // so the lookup key must be normalized the same way or free text that created
  // a project could never spawn a branch in it. Canonical names (what the UI
  // sends, straight from `listProjects`) pass through unchanged — normalization
  // is idempotent.
  const projectName = normalizeProjectName(requestedProjectName);
  const branchName = normalizeBranchName(requestedBranchName);

  const project = await deps.projectStore.findByName(machineId, projectName);
  if (!project) return { ok: false, reason: 'project_not_found' };

  const enablement = await deps.checkFullEgressEnablement();
  if (!enablement.ok) return enablement;

  const existing = await deps.store.findByName(machineId, projectName, branchName);
  const scopeKey = `${machineId}:${projectName}:${branchName}`;

  if (existing) {
    const handle = await deps.host.attach({ machineId: existing.sandboxId });
    if (handle) {
      // Refresh on every reattach, not just first spawn — Claude Code OAuth
      // credentials rotate, so a one-time copy would drift stale over time.
      await propagateClaudeCredential({ machineId, branchHandle: handle, resolveRootMachineHandle: deps.resolveRootMachineHandle });
      noteBranchStorage(deps.measureBranchStorage, { machineBranchId: existing.id, machinePageId: machineId, handle });
      return { ok: true, sandboxId: handle.machineId, branchName, resumed: true };
    }
    // Vanished — fall through and re-provision under the SAME session key.
  }

  const sessionKey =
    existing?.sessionKey ??
    deriveBranchSessionKey({ tenantId: actor.tenantId, machineId, projectName, branchName, secret: deps.secret });

  let handle: MachineHandle;
  try {
    handle = await deps.host.provision({ name: sessionKey, substrate: deps.substrate, options: deps.options });
  } catch (error) {
    return { ok: false, reason: 'provision_failed', detail: error instanceof Error ? error.message : String(error) };
  }

  const cloned = await cloneAndCheckoutBranch({ handle, repoUrl: project.repoUrl, branchName, scopeKey, actor, deps });
  if (!cloned.ok) {
    // A concurrent spawnBranch call for this SAME branch may have already won
    // (and may be sharing our exact Sprite — provision is name-keyed/idempotent),
    // in which case our redundant clone/checkout failing (e.g. "dir already
    // exists") doesn't mean the branch-terminal is broken.
    const reconciled = await reconcileProvisionCollision({ deps, machineId, projectName, branchName, handle });
    if ('ok' in reconciled) return reconciled;
    return { ok: false, reason: cloned.reason, detail: cloned.detail };
  }

  // Persist the row FIRST, before the credential copy — not after. A
  // concurrent racer's `reconcileProvisionCollision` (its own clone having
  // failed against this same name-keyed shared Sprite) looks up this branch's
  // row to decide whether the Sprite it's about to kill is actually the
  // winner's. Doing the credential copy's extra network I/O (a root-Sprite
  // read + branch-Sprite writes/execs) BEFORE that row exists would widen the
  // window in which no matching row exists yet — during which the racer would
  // find nothing, conclude it's *its own* redundant Sprite, and kill the very
  // Sprite this call is about to record as the winner (caught in review).
  if (existing) {
    const updated = await deps.store.updateSandboxId({
      id: existing.id,
      previousSandboxId: existing.sandboxId,
      sandboxId: handle.machineId,
      // WHICH VM this now is. `sandboxId` is the reused name and cannot say.
      spriteInstanceId: handle.spriteInstanceId ?? null,
      now: deps.now(),
    });
    if (!updated) {
      // Lost a race against a concurrent re-provision of the same vanished
      // branch — do not silently overwrite; the winner already wrote its own.
      const reconciled = await reconcileProvisionCollision({ deps, machineId, projectName, branchName, handle });
      if ('ok' in reconciled) return reconciled;
      if (reconciled.row) {
        return { ok: true, sandboxId: reconciled.row.sandboxId, branchName: reconciled.row.branchName, resumed: true };
      }
      return { ok: false, reason: 'error', detail: 'lost a concurrent branch-terminal spawn race' };
    }
    await propagateClaudeCredential({ machineId, branchHandle: handle, resolveRootMachineHandle: deps.resolveRootMachineHandle });
    // Measured right after the clone that wrote the bulk of this Sprite's
    // footprint — the one moment a branch's bytes are guaranteed non-trivial.
    noteBranchStorage(deps.measureBranchStorage, { machineBranchId: existing.id, machinePageId: machineId, handle });
    return { ok: true, sandboxId: handle.machineId, branchName, resumed: false, createdNew: cloned.createdNew };
  }

  let created: MachineBranchRecord;
  try {
    created = await deps.store.create({
      ownerId: actor.userId,
      machineId,
      projectName,
      branchName,
      sessionKey,
      sandboxId: handle.machineId,
      // WHICH VM this is — `sandboxId` is only the (reused) name.
      spriteInstanceId: handle.spriteInstanceId ?? null,
      now: deps.now(),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Lost a race against a concurrent spawn of the same branch.
      const reconciled = await reconcileProvisionCollision({ deps, machineId, projectName, branchName, handle });
      if ('ok' in reconciled) return reconciled;
      if (reconciled.row) {
        return { ok: true, sandboxId: reconciled.row.sandboxId, branchName: reconciled.row.branchName, resumed: true };
      }
      return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
    // ANY other failure to record the row (connection blip, aborted tx, statement
    // timeout) would otherwise leave the Sprite we just provisioned ALIVE with no
    // row anywhere — so nothing is ever deleted, no trigger fires, no reclaim is
    // enqueued, and the VM bills forever, unreachable. Kill it: the row is the
    // only thing that could ever have found it again. (`provisionFreshMachine`
    // has always done this on its own save failure; this path did not.)
    await safeKillSprite(deps.host, handle);
    return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
  }

  await propagateClaudeCredential({ machineId, branchHandle: handle, resolveRootMachineHandle: deps.resolveRootMachineHandle });
  // See above: the post-clone footprint, captured while this Sprite is still awake.
  noteBranchStorage(deps.measureBranchStorage, { machineBranchId: created.id, machinePageId: machineId, handle });
  return { ok: true, sandboxId: handle.machineId, branchName, resumed: false, createdNew: cloned.createdNew };
}

export type AttachBranchResult =
  | { ok: true; sandboxId: string; branchName: string }
  | { ok: false; reason: 'not_found' | 'vanished' };

/**
 * Reconnect to a branch-terminal's existing Sprite without provisioning a new
 * one. The lookup key is normalized the same way `spawnBranch` normalizes
 * before persisting, so the free text a user typed to create a branch still
 * finds it — and a name read back from `listBranches` (already canonical)
 * passes through untouched, because normalization is idempotent.
 */
export async function attachBranch({
  machineId,
  projectName: requestedProjectName,
  branchName: requestedBranchName,
  store,
  host,
  resolveRootMachineHandle,
  measureBranchStorage,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
  store: MachineBranchStore;
  host: MachineHost;
  resolveRootMachineHandle: (machineId: string) => Promise<MachineHandle | null>;
  /** Same optional storage-measurement seam as `MachineBranchesDeps.measureBranchStorage`. */
  measureBranchStorage?: (input: BranchStorageMeasurement) => Promise<void>;
}): Promise<AttachBranchResult> {
  // Shadow the raw params with their canonical forms, as `spawnBranch` does, so no
  // line below can reach the untrusted text by accident.
  const projectName = normalizeProjectName(requestedProjectName);
  const branchName = normalizeBranchName(requestedBranchName);

  const existing = await store.findByName(machineId, projectName, branchName);
  if (!existing) return { ok: false, reason: 'not_found' };

  const handle = await host.attach({ machineId: existing.sandboxId });
  if (!handle) return { ok: false, reason: 'vanished' };

  // Refresh on every reattach — see `propagateClaudeCredential`'s doc comment
  // on why this isn't a one-time, spawn-only copy.
  await propagateClaudeCredential({ machineId, branchHandle: handle, resolveRootMachineHandle });
  noteBranchStorage(measureBranchStorage, { machineBranchId: existing.id, machinePageId: machineId, handle });
  return { ok: true, sandboxId: handle.machineId, branchName };
}

/**
 * List a project's branch-terminals. Normalizes the project key like every other
 * name-keyed lookup IN THIS MODULE. (The sibling agent-terminal / files / diff
 * surfaces do not yet — they take these names as free-text params too, so a
 * direct API caller can hit `project_not_found` there with text that works here.
 * The UI is unaffected: it passes canonical names straight back from the list
 * APIs. Closing that gap needs the realtime session-key path too, so it is a
 * follow-up, not a drive-by.)
 */
export async function listBranches({
  machineId,
  projectName,
  store,
}: {
  machineId: string;
  projectName: string;
  store: MachineBranchStore;
}): Promise<MachineBranchRecord[]> {
  return store.list(machineId, normalizeProjectName(projectName));
}

export type KillBranchResult = { ok: true } | { ok: false; reason: 'not_found' | 'error' };

/**
 * Tear down a branch-terminal: DELETE its Sprite through the MachineHost seam
 * and drop the tracking row. Normalizes its lookup key for the same reason
 * `attachBranch` does — whatever text created a branch must also be able to
 * kill it, and a canonical name from `listBranches` passes through unchanged.
 */
export async function killBranch({
  machineId,
  projectName: requestedProjectName,
  branchName: requestedBranchName,
  store,
  host,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
  store: MachineBranchStore;
  host: MachineHost;
}): Promise<KillBranchResult> {
  const projectName = normalizeProjectName(requestedProjectName);
  const branchName = normalizeBranchName(requestedBranchName);

  const existing = await store.findByName(machineId, projectName, branchName);
  if (!existing) return { ok: false, reason: 'not_found' };

  try {
    // Identity-guarded: the kill is name-keyed, and a name is reused across
    // re-creates, so without this a Sprite re-provisioned under this branch's key
    // would be destroyed in place of the one we meant.
    await host.kill({ machineId: existing.sandboxId, expectedInstanceId: existing.spriteInstanceId ?? undefined });
  } catch {
    // Sprite may still be running — keep the tracking row so a retry can still
    // find and kill it later. There is no reaper: an untracked-but-live Sprite
    // would otherwise be an unkillable orphan.
    return { ok: false, reason: 'error' };
  }

  // CAS on sandboxId, NOT a name-keyed delete: `spawnBranch` re-provisions a
  // vanished branch under this same (machine, project, branch) identity, so a
  // concurrent spawn can write a REPLACEMENT Sprite into this row between our
  // kill above and this delete. Deleting by name would then destroy the pointer
  // to that brand-new, LIVE Sprite — leaving it billing forever, invisible even
  // to the orphan reconciler. Losing the CAS is the correct outcome: the winner's
  // Sprite is live and tracked, and the one we killed was already redundant.
  await store.removeIfSandbox({
    id: existing.id,
    sandboxId: existing.sandboxId,
    spriteInstanceId: existing.spriteInstanceId,
  });
  return { ok: true };
}
