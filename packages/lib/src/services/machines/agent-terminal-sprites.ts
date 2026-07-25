/**
 * Per-session Sprite provisioning for agent terminals (IO, dependency-injected).
 *
 * Every spawned agent-terminal session (`machine_agent_terminals` row) gets its
 * OWN, SEPARATE Sprite — exactly the way a branch-terminal (`machine-branches.ts`)
 * always has, and a promoted project (`machine-project-promotion.ts`) does. This
 * is `spawnBranch`'s provisioning template applied per session: same `MachineHost`
 * seam, same HMAC-named provision (`deriveAgentTerminalSessionSpriteKey`, its own
 * namespace keyed on the terminal ROW id), same hardened `runGitInSandbox` clone
 * (reusing `cloneAndCheckoutBranch`/`cloneRepoInto` lifted from
 * machine-branches.ts), same `propagateClaudeCredential` copy FROM the owning
 * Machine's root Sprite (the login anchor — never changed here), and the same
 * identity columns to CAS against (`updateSpriteIdentity`).
 *
 * Per scope:
 *  - `machine`: no clone — the session runs at the Sprite's home (SANDBOX_ROOT).
 *  - `project`: clone the project's repo into PROJECT_REPO_PATH.
 *  - `branch`: clone + checkout the branch into BRANCH_REPO_PATH.
 *
 * This is invoked from `spawnAgentTerminal` after the row is reserved (the row's
 * id is the Sprite-key fold, so the row must exist first). It is BEST-EFFORT to
 * the spawn: a provisioning failure leaves the row with a NULL `sandboxId`,
 * which `resolveLocationForRow` resolves via the pre-per-session shared-Sprite
 * fallback and a later spawn re-provisions — the session is never left broken,
 * and no billing VM is ever left unreferenced: every failure after a successful
 * provision routes through `reconcileBeforeKill`, which waits (bounded) for a
 * concurrent winner before killing, and rescues the Sprite into the reclaim
 * outbox when its cleanup kill cannot be confirmed.
 */

import type { MachineHandle, MachineHost, MachineSubstrateSpec } from '../sandbox/machine-host';
import { MachineSpriteReplacedError } from '../sandbox/machine-host';
import type { SandboxCreateOptions } from '../sandbox/sandbox-options';
import type { FullEgressEnablement } from '../sandbox/containment';
import type { CanRunCodeInput, CanRunCodeResult } from '../sandbox/can-run-code';
import { PROJECT_REPO_PATH } from '../sandbox/sandbox-paths';
import {
  cloneAndCheckoutBranch,
  cloneRepoInto,
  propagateClaudeCredential,
  type MachineActorContext,
  type SpriteCloneDeps,
} from './machine-branches';
import { deriveAgentTerminalSessionSpriteKey } from './agent-terminal-sprite-session';
import type { MachineAgentTerminalRecord, MachineAgentTerminalStore } from './agent-terminals-store';

export type { MachineActorContext };

/** The Sprite-provisioning slice of the agent-terminals deps — mirrors the Sprite fields of `MachineBranchesDeps`. */
export interface AgentTerminalSpriteProvisionDeps extends SpriteCloneDeps {
  /** CAS the provisioned Sprite identity onto the terminal row. */
  updateSpriteIdentity: (input: {
    id: string;
    previousSandboxId: string | null;
    sessionKey: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    egressPolicyToken: string | null;
    now: Date;
  }) => Promise<boolean>;
  /**
   * Re-read the row's persisted Sprite pointer AND INSTANCE, to RECONCILE a lost
   * provisioning race against the winner BEFORE killing — the agent-terminal twin
   * of `reconcileProvisionCollision` (machine-branches.ts). `MachineHost.provision`
   * is name-keyed, so two concurrent provisions of the same unprovisioned row
   * (same derived key) can hold the SAME physical Sprite; the CAS loser must not
   * kill the very VM the winner just recorded. `spriteInstanceId` is load-bearing:
   * a genuine winner recorded OUR generation (same instance), whereas a
   * vanished-heal reprovision that failed leaves the OLD stale instance behind —
   * see `reconcileBeforeKill`.
   */
  reloadRow: (id: string) => Promise<{ sandboxId: string | null; spriteInstanceId: string | null } | null>;
  /**
   * Pause, injected so `reconcileBeforeKill`'s bounded winner-poll is testable
   * against a fake clock (no real sleeps) — mirrors `PromoteProjectDeps.wait` /
   * `awaitPromotionWinner` (machine-project-promotion.ts).
   */
  wait: (ms: number) => Promise<void>;
  /**
   * Enqueue a Sprite pointer into the reclaim outbox (`machine_sprite_reclaims`).
   * The provisioning failure path uses it when a cleanup kill CANNOT be confirmed:
   * the row still has a NULL `sandboxId` (the identity was never persisted), so
   * neither the AFTER-DELETE trigger nor the tracking-row reconciler could ever
   * discover the live, billed VM — the outbox is its only reclaim path.
   */
  enqueueReclaim: (input: { sandboxId: string; spriteInstanceId: string | null }) => Promise<void>;
  /** The provider-neutral Sprite lifecycle seam. */
  host: MachineHost;
  substrate: MachineSubstrateSpec;
  options: SandboxCreateOptions;
  /** Server-held secret for Sprite-key derivation (same secret as machine-session-manager.ts). */
  secret: string;
  /**
   * Centralized code-execution authorization for the CURRENT actor, applied
   * BEFORE any Sprite is provisioned (finding P — SECURITY). Same shape and
   * fail-closed contract the session managers use (`authorize: canRunCode`,
   * `machine-session.ts` / `tool-gate.ts`): it is the STRONGER check the realtime
   * attach path enforces (app-admin + owner/admin drive role), whereas the spawn
   * route only checked edit-level page access. Without it an editor correctly
   * denied code execution could still create billable, full-egress Sprites by
   * spawning terminals under distinct names. Must never throw.
   */
  authorize: (input: CanRunCodeInput) => Promise<CanRunCodeResult>;
  /** Resolve the machine page's owning drive id — needed to run the drive-role arm of `authorize`. `null` when the page/drive can't be resolved (then authorization fails closed). */
  resolveDriveId: (machineId: string) => Promise<string | null>;
  /** REQUIRED full-egress enablement gate — a session Sprite runs open egress, same as a branch's. */
  checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  /** Live handle to the OWNING Machine's own persistent Sprite — the source the Claude Code credential is copied from. `null` = graceful no-op. */
  resolveRootMachineHandle: (machineId: string) => Promise<MachineHandle | null>;
  /** A project's clone URL by (machineId, projectName). Needed for project- and branch-scope clones; unused for machine scope. */
  resolveProjectRepoUrl: (machineId: string, projectName: string) => Promise<string | null>;
  /** A branch's checked-out name by its `machine_branches` row id. Needed only for branch-scope clones. */
  resolveBranchName: (machineBranchId: string) => Promise<string | null>;
  /**
   * Optional opportunistic storage-measurement seam (mirrors
   * `MachineBranchesDeps.measureBranchStorage`). While this session's Sprite is
   * ALREADY awake right after provision/clone, capture its used bytes onto its
   * own `machine_agent_terminals` row so the storage reconcile bills them to the
   * OWNING Machine page — without ever waking a hibernating Sprite. Best-effort
   * and fire-and-forget; omitting it disables measurement (the reconcile then
   * bills the conservative never-measured 0 floor).
   */
  measureAgentTerminalStorage?: (input: {
    machineAgentTerminalId: string;
    machinePageId: string;
    handle: MachineHandle;
  }) => Promise<void>;
}

export type ProvisionAgentTerminalSpriteResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | {
      ok: false;
      reason:
        | 'unauthorized'
        | 'egress_denied'
        | 'project_not_found'
        | 'branch_not_found'
        | 'provision_failed'
        | 'clone_failed'
        | 'persist_failed'
        | 'race_lost';
      detail?: string;
    };

/** How many EXTRA reloads `awaitProvisionWinner` makes after its first, and the pause between them — mirrors `PROMOTION_RACE_POLLS`/`_MS` (machine-project-promotion.ts). */
const AGENT_TERMINAL_RACE_POLLS = 3;
const AGENT_TERMINAL_RACE_POLL_MS = 250;

/**
 * Bounded wait for a concurrent WINNER that recorded OUR GENERATION onto this row
 * — the agent-terminal twin of `awaitPromotionWinner` (machine-project-promotion.ts).
 *
 * `MachineHost.provision` is name-keyed, so two first spawns of the same row can
 * hold the SAME physical Sprite; one clone can fail (the other already created
 * the checkout) WHILE the successful caller has not yet run its persisting CAS. A
 * single immediate reload would then see no winner and wrongly conclude the
 * shared Sprite is unreferenced. So we re-read a bounded number of times (first
 * read immediate, then `deps.wait` between the rest).
 *
 * A row counts as a WINNER only when its `spriteInstanceId` MATCHES `ourInstance`
 * (both non-null) — the generation of the handle WE hold (finding Q). In the true
 * concurrent race both callers share the SAME name-keyed physical VM, so same
 * instance ⇒ genuine shared winner. But when HEALING a vanished Sprite the row
 * already carries a non-null `sandboxId` (the reused deterministic name) with the
 * OLD, STALE instance; a reprovision whose clone/persist failed before recording
 * the replacement would otherwise make a name-only check mistake that stale
 * pointer for a winner and falsely resume against a checkout that may not exist.
 * Matching on the instance rejects it. A null `ourInstance` can never be proven a
 * winner — fail closed (never match).
 */
async function awaitProvisionWinner(
  deps: Pick<AgentTerminalSpriteProvisionDeps, 'reloadRow' | 'wait'>,
  rowId: string,
  ourInstance: string | null,
): Promise<{ sandboxId: string } | null> {
  for (let attempt = 0; attempt <= AGENT_TERMINAL_RACE_POLLS; attempt += 1) {
    const row = await deps.reloadRow(rowId).catch(() => null);
    if (row?.sandboxId && ourInstance !== null && row.spriteInstanceId === ourInstance) {
      return { sandboxId: row.sandboxId };
    }
    if (attempt < AGENT_TERMINAL_RACE_POLLS) await deps.wait(AGENT_TERMINAL_RACE_POLL_MS);
  }
  return null;
}

/**
 * Destroy a Sprite we hold that is genuinely unreferenced (no winner recorded it)
 * — and, when the kill CANNOT be confirmed, RESCUE its pointer into the reclaim
 * outbox (finding Y).
 *
 * The provisioning row still has a NULL `sandboxId` at every call site here (the
 * identity was never persisted, or a re-provision cleared it), so unlike a killed
 * branch/project row there is NO AFTER-DELETE trigger and NO tracking-row
 * reconciler that could ever find this VM. A fire-and-forget kill that swallows
 * its error would therefore leak a billed VM forever on any provider hiccup. So:
 * kill and check the outcome; a genuine failure enqueues the handle for the
 * orphan reconciler's tier-A to retry. A confirmed kill (or a `MachineSpriteReplacedError`,
 * meaning a replacement already took the name — our target is already gone) needs
 * no enqueue.
 */
async function killUnreferencedOrEnqueue(
  deps: Pick<AgentTerminalSpriteProvisionDeps, 'host' | 'enqueueReclaim'>,
  handle: MachineHandle,
): Promise<void> {
  try {
    await deps.host.kill({ machineId: handle.machineId, expectedInstanceId: handle.spriteInstanceId });
    return; // confirmed dead
  } catch (error) {
    // A different VM holds this name now → our target is already gone; the
    // newcomer has its OWN row and must not be enqueued.
    if (error instanceof MachineSpriteReplacedError) return;
    // Unconfirmed kill: the VM may still be alive and billing, and nothing else
    // points at it. Enqueue it so the reconciler retries. Best-effort itself —
    // if even the enqueue fails there is nothing more we can do here.
    await deps
      .enqueueReclaim({ sandboxId: handle.machineId, spriteInstanceId: handle.spriteInstanceId ?? null })
      .catch(() => {
        /* best-effort: the outbox insert failed too; the provisioning failure is still reported. */
      });
  }
}

/**
 * Reconcile against the persisted row BEFORE killing a Sprite we hold, at ANY
 * post-provision failure site (a failed clone, a failed/lost persist).
 *
 * `MachineHost.provision` is name-keyed on the row's deterministic session key,
 * so a concurrent provision of the SAME row can hand BOTH callers the SAME
 * physical Sprite. Killing "ours" — passing the same `spriteInstanceId` the
 * winner recorded — would DESTROY the winner's live, referenced VM. So: wait
 * (bounded) for a winner that recorded OUR GENERATION (same `spriteInstanceId` —
 * see `awaitProvisionWinner`). If one exists, the row points at the very live VM
 * we hold — resume, do NOT kill. Otherwise (no winner, or the row holds only a
 * STALE pre-reprovision instance) our Sprite is unreferenced for this generation
 * — kill it via `killUnreferencedOrEnqueue`, which rescues it to the outbox if
 * the kill cannot be confirmed.
 *
 * This is the single reconcile-before-kill the CAS-loss path introduced, lifted
 * so every kill site shares it (branch clone-fail, project clone-fail, and the
 * persist-throw path all route through it).
 */
async function reconcileBeforeKill({
  deps,
  row,
  handle,
}: {
  deps: Pick<AgentTerminalSpriteProvisionDeps, 'reloadRow' | 'wait' | 'host' | 'enqueueReclaim'>;
  row: Pick<MachineAgentTerminalRecord, 'id'>;
  handle: MachineHandle;
}): Promise<{ kind: 'resumed'; sandboxId: string } | { kind: 'killed' }> {
  const winner = await awaitProvisionWinner(deps, row.id, handle.spriteInstanceId ?? null);
  if (winner) {
    // The row records OUR instance — it is the live, referenced VM we hold (a
    // genuine shared winner). Must NOT kill; resume against it.
    return { kind: 'resumed', sandboxId: winner.sandboxId };
  }
  // No row records our generation — no winner, or only a STALE pre-reprovision
  // instance (a vanished-heal whose replacement never landed). Ours is
  // unreferenced: kill it (or rescue it to the outbox) rather than leak a VM.
  await killUnreferencedOrEnqueue(deps, handle);
  return { kind: 'killed' };
}

/**
 * Provision (or resume) this session's OWN Sprite and record it on the row.
 * Idempotent by the row's own id: the Sprite key folds the row id, so a
 * re-provision of a vanished Sprite lands on the same name. Caller passes a row
 * whose `sandboxId` is currently NULL (a fresh reservation, or a legacy/failed
 * row being healed); a row that already has a live `sandboxId` should never
 * reach here (the spawn/resolve paths reattach to it directly).
 */
export async function provisionAgentTerminalSprite({
  row,
  actor,
  deps,
}: {
  row: Pick<MachineAgentTerminalRecord, 'id' | 'machineId' | 'projectName' | 'machineBranchId' | 'sessionKey' | 'sandboxId' | 'egressPolicyToken'>;
  actor: MachineActorContext;
  deps: AgentTerminalSpriteProvisionDeps;
}): Promise<ProvisionAgentTerminalSpriteResult> {
  // SECURITY (finding P): apply the centralized code-execution authorization for
  // the CURRENT actor BEFORE anything is provisioned — the same STRONGER check
  // the realtime attach path enforces (app-admin + owner/admin drive role), not
  // the weaker edit-level page access the spawn route already checked. Denied →
  // skip provisioning entirely; the row keeps a NULL sandboxId and the
  // resolve/attach path (which independently re-runs this check) governs from
  // there. Resolved with `requestOrigin: 'user'` to match that attach path.
  const driveId = await deps.resolveDriveId(row.machineId);
  const authorized = await deps.authorize({
    userId: actor.userId,
    driveId: driveId ?? undefined,
    requestOrigin: 'user',
  });
  if (!authorized.ok) return { ok: false, reason: 'unauthorized', detail: authorized.reason };

  const enablement = await deps.checkFullEgressEnablement();
  if (!enablement.ok) return { ok: false, reason: 'egress_denied', detail: enablement.reason };

  const scopeKey = `agent-terminal:${row.id}`;

  // Resolve what the clone needs BEFORE provisioning a VM, so a missing
  // project/branch never leaks a Sprite. Machine scope needs nothing.
  let repoUrl: string | null = null;
  let branchName: string | null = null;
  if (row.machineBranchId) {
    branchName = await deps.resolveBranchName(row.machineBranchId);
    if (!branchName) return { ok: false, reason: 'branch_not_found' };
    if (!row.projectName) return { ok: false, reason: 'project_not_found' };
    repoUrl = await deps.resolveProjectRepoUrl(row.machineId, row.projectName);
    if (!repoUrl) return { ok: false, reason: 'project_not_found' };
  } else if (row.projectName) {
    repoUrl = await deps.resolveProjectRepoUrl(row.machineId, row.projectName);
    if (!repoUrl) return { ok: false, reason: 'project_not_found' };
  }

  const sessionKey =
    row.sessionKey ??
    deriveAgentTerminalSessionSpriteKey({
      tenantId: actor.tenantId,
      machineId: row.machineId,
      terminalId: row.id,
      secret: deps.secret,
    });

  let handle: MachineHandle;
  try {
    handle = await deps.host.provision({
      name: sessionKey,
      substrate: deps.substrate,
      options: deps.options,
      appliedEgressToken: row.egressPolicyToken ?? null,
    });
  } catch (error) {
    return { ok: false, reason: 'provision_failed', detail: error instanceof Error ? error.message : String(error) };
  }

  // Clone per scope. On failure, DON'T blindly kill: a concurrent winner sharing
  // our name-keyed Sprite may have created the checkout dir (which is exactly why
  // our redundant clone failed) and already persisted/returned it — killing it
  // would destroy the winner's live VM. Reconcile first (see `reconcileBeforeKill`).
  if (row.machineBranchId && repoUrl && branchName) {
    const cloned = await cloneAndCheckoutBranch({ handle, repoUrl, branchName, scopeKey, actor, deps });
    if (!cloned.ok) {
      const outcome = await reconcileBeforeKill({ deps, row, handle });
      if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
      return { ok: false, reason: 'clone_failed', detail: cloned.detail };
    }
  } else if (row.projectName && repoUrl) {
    const cloned = await cloneRepoInto({ handle, repoUrl, targetPath: PROJECT_REPO_PATH, scopeKey, actor, deps });
    if (!cloned.ok) {
      const outcome = await reconcileBeforeKill({ deps, row, handle });
      if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
      return { ok: false, reason: 'clone_failed', detail: cloned.detail };
    }
  }
  // machine scope: no clone — cwd is the Sprite home (SANDBOX_ROOT).

  // Persist the identity FIRST (before the credential copy), under a CAS on the
  // row's CURRENT sandboxId — so a concurrent provision of the same
  // unprovisioned row cannot both win.
  let recorded: boolean;
  try {
    recorded = await deps.updateSpriteIdentity({
      id: row.id,
      previousSandboxId: row.sandboxId,
      sessionKey,
      sandboxId: handle.machineId,
      spriteInstanceId: handle.spriteInstanceId ?? null,
      egressPolicyToken: handle.egressPolicyToken ?? null,
      now: deps.now(),
    });
  } catch (error) {
    // FINDING 2: a transient DB error here would otherwise escape (swallowed by
    // `maybeProvisionSprite`) leaving the Sprite ALIVE with a NULL row pointer —
    // billing forever, and invisible to the reclaim trigger (which needs a
    // non-null sandboxId). But a blind kill has the SAME shared-winner hazard as
    // the clone sites: if our `updateSpriteIdentity` threw while a concurrent
    // winner's CAS on the same name-keyed Sprite succeeded (or ours committed and
    // only the response threw), killing "ours" destroys the winner's — or our
    // own now-referenced — live VM. Reconcile before killing.
    const outcome = await reconcileBeforeKill({ deps, row, handle });
    if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
    return { ok: false, reason: 'persist_failed', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!recorded) {
    // FINDING 1: our CAS lost — another provision recorded a Sprite for this row
    // first. The winner may hold our EXACT name-keyed physical Sprite, so
    // reconcile before killing (the shared reconcile-before-kill).
    const outcome = await reconcileBeforeKill({ deps, row, handle });
    if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
    return { ok: false, reason: 'race_lost' };
  }

  // Copy the Claude Code credential FROM the owning Machine's root Sprite — the
  // login anchor — exactly as spawnBranch does. Best-effort inside.
  await propagateClaudeCredential({
    machineId: row.machineId,
    branchHandle: handle,
    resolveRootMachineHandle: deps.resolveRootMachineHandle,
  });

  // Measure this session Sprite's footprint while it is still awake right after
  // the provision/clone — the one moment its bytes are guaranteed non-trivial,
  // exactly as spawnBranch measures a branch. Fire-and-forget: a billing concern
  // must never be awaited by (or fail) the spawn.
  if (deps.measureAgentTerminalStorage) {
    void deps
      .measureAgentTerminalStorage({ machineAgentTerminalId: row.id, machinePageId: row.machineId, handle })
      .catch(() => {
        /* Best-effort: the seam already logs; a spawn must never fail on it. */
      });
  }

  return { ok: true, sandboxId: handle.machineId, resumed: false };
}

/** The store slice `teardownProjectAgentTerminalSprites` needs — enumerate a scope's rows and CAS-delete one (dropping or rescuing the reclaim pointer). */
export interface TeardownProjectAgentTerminalsDeps {
  store: Pick<MachineAgentTerminalStore, 'list' | 'removeIfSandbox' | 'removeIfSandboxToReclaim'>;
  /**
   * Identity-guarded kill of a session's OWN Sprite. `ok: true` means the target
   * is CONFIRMED gone (killed, or a replacement already took its name); `ok:
   * false` means a genuine failure where it may still be alive. Same shape/
   * contract as `removeProject`'s `killSprite` (machine-projects.ts).
   */
  killSprite: (input: { sandboxId: string; spriteInstanceId: string | null }) => Promise<{ ok: boolean }>;
}

/**
 * Tear down the OWN Sprites of a project's PROJECT-SCOPED agent terminals when
 * the project is removed.
 *
 * A project-scoped `machine_agent_terminals` row links to its project only by
 * `projectName` TEXT (no FK), so — unlike a BRANCH-scoped row, whose
 * `machineBranchId` FK cascades on branch deletion and whose Sprite pointer the
 * AFTER-DELETE reclaim trigger then rescues — it does NOT cascade when the
 * `machine_projects` row is deleted. Without this, removing a project strands its
 * sessions' live, billed Sprites, and a recreated same-name project could resume
 * a stale terminal row against its old checkout.
 *
 * Mirrors `removeProject`'s own-Sprite teardown and `killOwnSprite`: an
 * identity-guarded kill (via `killSprite`, best-effort), then a CAS delete that
 * BOTH prevents a stale resume (the row is gone) AND is generation-safe — a row
 * whose Sprite was re-provisioned since we listed it fails the CAS, so its live
 * replacement is left untouched.
 *
 * The row is deleted whether the kill SUCCEEDED or FAILED (finding Z): the
 * project row is being deleted with no page trash, so `teardownRequestedAt` is
 * never set and the orphan reconciler's tracking-row arm would NOT retry a
 * survivor — leaving a failed kill's live Sprite billing forever AND letting a
 * recreated same-name project resume it. Deleting the row instead routes reclaim
 * through the outbox: on a CONFIRMED kill, `removeIfSandbox` drops the redundant
 * pointer; on an UNCONFIRMED kill, `removeIfSandboxToReclaim` LEAVES the pointer
 * the AFTER-DELETE trigger (0229) enqueues, so tier-A of the reconciler retries
 * the kill. Only a row we could not even attempt (no `sandboxId` / already torn
 * down) is skipped. Per-row isolated: one unreachable Sprite never skips the rest.
 */
export async function teardownProjectAgentTerminalSprites({
  machineId,
  projectName,
  deps,
}: {
  machineId: string;
  projectName: string;
  deps: TeardownProjectAgentTerminalsDeps;
}): Promise<void> {
  const rows = await deps.store.list({ machineId, projectName, machineBranchId: null });
  for (const row of rows) {
    // Only rows with a live Sprite of their OWN: a legacy/unprovisioned row has
    // nothing to kill, a torn-down one is already gone.
    if (!row.sandboxId || row.spriteTornDownAt) continue;
    const { id, sandboxId, spriteInstanceId } = row;
    try {
      const killed = await deps.killSprite({ sandboxId, spriteInstanceId });
      if (killed.ok) {
        // Confirmed dead → CAS-delete and DROP the redundant reclaim pointer.
        await deps.store.removeIfSandbox({ id, sandboxId, spriteInstanceId });
      } else {
        // Unconfirmed → CAS-delete but KEEP the pointer the trigger enqueues, so
        // the reconciler retries the (maybe still live) Sprite. Prevents the
        // stale-resume either way (the row is gone).
        await deps.store.removeIfSandboxToReclaim({ id, sandboxId, spriteInstanceId });
      }
    } catch {
      // Per-row best-effort — one unreachable Sprite must not skip the rest. The
      // row survives here (a throw is not a definitive kill outcome); a later
      // machine teardown/purge reclaims it.
    }
  }
}
