/**
 * Production wiring for Machine Branches (Terminal — Workspace, Branches tier).
 *
 * Binds the provider-agnostic orchestration (`@pagespace/lib/services/machines/
 * machine-branches`) to the real implementations. Unlike Projects (which clone
 * onto the OWNING Machine's own persistent Sprite session), a branch-terminal
 * is its OWN, SEPARATE Sprite — provisioned directly through the `MachineHost`
 * seam (`createProductionMachineHost`, `apps/web/src/lib/sandbox/sprites-client.ts`),
 * never through `acquireMachineSession`/`machine_sessions`. Real isolation
 * between two branches of one project comes from two distinct Sprites, which
 * requires never routing through the single page-keyed session Projects share.
 *
 * Every operation re-checks page access for the CURRENT actor (resume
 * re-authz, the same invariant the Terminal sandbox lifecycle enforces).
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages, drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { decideFullEgressEnablement, isContainmentVerified } from '@pagespace/lib/services/sandbox/containment';
import { getSandboxSessionSecret, findLiveMachineSandboxId } from '@pagespace/lib/services/sandbox/machine-session-manager';
import { resolveSandboxNetworkOptions } from '@pagespace/lib/services/sandbox/network-options';
import { getConfiguredEgressIpTag } from '@pagespace/lib/services/sandbox/egress-ip';
import { acquireCodeExecutionSlot, releaseCodeExecutionSlot } from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { defaultBuildEnv } from '@pagespace/lib/services/sandbox/tool-runners';
import { resolveGitHubTokenForSandbox } from '@pagespace/lib/services/sandbox/github-token';
import { isMachinePage } from '@pagespace/lib/content/page-types.config';
import type { PageType } from '@pagespace/lib/utils/enums';
import type { MachineHandle, MachineHost } from '@pagespace/lib/services/sandbox/machine-host';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { canUserEditPage, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';
import { createDbMachineProjectStore } from '@pagespace/lib/services/machines/machine-projects-store';
import type { MachineActorContext, MachineBranchesDeps } from '@pagespace/lib/services/machines/machine-branches';
import { measureBranchStorageOpportunistically } from '@pagespace/lib/services/sandbox/machine-storage-billing';

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one —
// @fly/sprites is ESM-only and @pagespace/lib compiles to CJS. Mirrors the
// same guard as machine-projects-runtime.ts / sandbox-tools-runtime.ts.
const MIN_SANDBOX_NODE_MAJOR = 24;

function assertSandboxRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < MIN_SANDBOX_NODE_MAJOR) {
    throw new Error(
      `Machine sandbox access requires Node.js >= ${MIN_SANDBOX_NODE_MAJOR} ` +
        `(the @fly/sprites SDK is Node ${MIN_SANDBOX_NODE_MAJOR}+ / ESM-only); ` +
        `this process is Node ${process.versions.node}.`,
    );
  }
}

let machineHostPromise: Promise<MachineHost> | null = null;
function getMachineHost(): Promise<MachineHost> {
  machineHostPromise ??= (async () => {
    assertSandboxRuntime();
    const { createProductionMachineHost } = await import('@/lib/sandbox/sprites-client');
    return createProductionMachineHost();
  })().catch((error) => {
    machineHostPromise = null;
    throw error;
  });
  return machineHostPromise;
}

let branchStorePromise: ReturnType<typeof createDbMachineBranchStore> | null = null;
function getMachineBranchStore() {
  branchStorePromise ??= createDbMachineBranchStore();
  return branchStorePromise;
}

let projectStorePromise: ReturnType<typeof createDbMachineProjectStore> | null = null;
function getMachineProjectStore() {
  projectStorePromise ??= createDbMachineProjectStore();
  return projectStorePromise;
}

export async function resolveMachineActorContext(userId: string): Promise<MachineActorContext> {
  const [user, actorInfo] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { subscriptionTier: true } }),
    getActorInfo(userId),
  ]);
  return {
    userId,
    tenantId: userId,
    actorEmail: actorInfo.actorEmail,
    actorDisplayName: actorInfo.actorDisplayName,
    tier: toSubscriptionTier(user?.subscriptionTier),
  };
}

async function findMachinePage(machineId: string) {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, machineId),
    columns: { type: true, driveId: true },
  });
  if (!page || !isMachinePage(page.type as PageType)) return null;
  return page;
}

/** Edit-level access (spawn/kill) — re-checked on every acquire, not cached. */
export async function canAccessMachine(actorUserId: string, machineId: string): Promise<boolean> {
  const page = await findMachinePage(machineId);
  if (!page) return false;
  return canUserEditPage(actorUserId, machineId);
}

/** View-level access (list/attach) — looser than edit-level. */
export async function canViewMachine(actorUserId: string, machineId: string): Promise<boolean> {
  const page = await findMachinePage(machineId);
  if (!page) return false;
  return canUserViewPage(actorUserId, machineId);
}

/**
 * Live handle to the ROOT Machine's own persistent Sprite (the one
 * `machine_sessions` tracks for its page), never a branch-terminal's own.
 * Read-only — never goes through `acquireMachineSession`'s full re-authz +
 * provision-fresh flow, since this only ever needs read access to an
 * EXISTING session, gracefully returning `null` (never provisioning) when
 * the root Machine has none yet.
 *
 * Resolves the page's CURRENT driveId/owner and derives the exact session
 * key from it — not a bare-`pageId` lookup (see `findLiveMachineSandboxId`'s
 * doc comment): a page moved between drives can leave its OLD drive's
 * session row behind, and a bare-`pageId` read could return that STALE row,
 * handing back a credential that was never this page's current owner's to
 * give out.
 */
export async function resolveRootMachineHandle(machineId: string): Promise<MachineHandle | null> {
  const page = await findMachinePage(machineId);
  if (!page) return null;

  const driveRow = await db.query.drives.findFirst({
    where: eq(drives.id, page.driveId),
    columns: { ownerId: true },
  });
  if (!driveRow) return null;

  const sandboxId = await findLiveMachineSandboxId({
    tenantId: driveRow.ownerId,
    driveId: page.driveId,
    pageId: machineId,
    secret: getSandboxSessionSecret(),
  });
  if (!sandboxId) return null;

  const host = await getMachineHost();
  return host.attach({ machineId: sandboxId });
}

export function buildMachineBranchesDeps(): MachineBranchesDeps {
  return {
    store: {
      list: async (machineId, projectName) => (await getMachineBranchStore()).list(machineId, projectName),
      listForMachine: async (machineId) => (await getMachineBranchStore()).listForMachine(machineId),
      findByName: async (machineId, projectName, branchName) =>
        (await getMachineBranchStore()).findByName(machineId, projectName, branchName),
      findById: async (id) => (await getMachineBranchStore()).findById(id),
      create: async (input) => (await getMachineBranchStore()).create(input),
      updateSandboxId: async (input) => (await getMachineBranchStore()).updateSandboxId(input),
      remove: async (machineId, projectName, branchName) =>
        (await getMachineBranchStore()).remove(machineId, projectName, branchName),
      removeIfSandbox: async (input) => (await getMachineBranchStore()).removeIfSandbox(input),
    },
    projectStore: {
      findByName: async (machineId, name) => (await getMachineProjectStore()).findByName(machineId, name),
    },
    isEnabled: isCodeExecutionEnabled,
    now: () => new Date(),
    host: {
      provision: async (args) => (await getMachineHost()).provision(args),
      attach: async (args) => (await getMachineHost()).attach(args),
      kill: async (args) => (await getMachineHost()).kill(args),
    },
    substrate: { kind: 'sprite' },
    options: resolveSandboxNetworkOptions({ surface: 'machine', egressIpTag: getConfiguredEgressIpTag() }),
    secret: getSandboxSessionSecret(),
    checkFullEgressEnablement: async () =>
      decideFullEgressEnablement({
        adminGateEnabled: isCodeExecutionEnabled(),
        containment: isContainmentVerified() ? { contained: true } : null,
      }),
    resolveGitHubToken: (userId) => resolveGitHubTokenForSandbox({ userId, db }),
    resolveRootMachineHandle,
    quota: {
      acquireSlot: acquireCodeExecutionSlot,
      releaseSlot: releaseCodeExecutionSlot,
    },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    // Issue #2204 phase 3: while this branch's Sprite is awake for the spawn/
    // clone or reattach, measure its used bytes onto its own `machine_branches`
    // row so the storage reconcile bills them to the OWNING Machine page — the
    // key the per-machine usage breakdown groups on. Throttled and best-effort
    // inside the seam; never wakes a hibernating Sprite.
    measureBranchStorage: ({ machineBranchId, machinePageId, handle }) =>
      measureBranchStorageOpportunistically({ machineBranchId, machinePageId, handle }),
  };
}

/** The raw `MachineHost`, for `attachBranch`/`killBranch` which don't need the full spawn deps. */
export async function getMachineHostForBranches(): Promise<MachineHost> {
  return getMachineHost();
}
