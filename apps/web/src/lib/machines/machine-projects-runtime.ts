/**
 * Production wiring for Machine Projects (Terminal — Workspace, Projects tier).
 *
 * Binds the provider-agnostic orchestration (`@pagespace/lib/services/machines/
 * machine-projects`) to the real implementations. A Machine's identity is its
 * backing page (`machineId`) — Projects clone onto the SAME persistent Sprite
 * session (`machine_sessions` / `acquireMachineSession`) that a live
 * Terminal shell or a page-agent's "own machine" tool calls already
 * reconnect to, not a separate one. The underlying Sprite client
 * (`createProductionSpritesSandboxClient`) is composed through the MachineHost
 * seam (`sprite-machine-host.ts` / `machine-host-adapter.ts`) — this module
 * never imports the Sprites SDK or `sandbox-client/sprites.ts` directly.
 *
 * Every acquire re-checks page access for the CURRENT actor (resume re-authz,
 * the same invariant the Terminal sandbox lifecycle enforces) and consults the
 * shared machine-runtime guardrail (quota.ts), so Project operations can't run
 * a machine past the same active-runtime backstop agent tool calls respect.
 */

import { createId } from '@paralleldrive/cuid2';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages, drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { decideFullEgressEnablement, isContainmentVerified } from '@pagespace/lib/services/sandbox/containment';
import {
  acquireMachineSession,
  createDbMachineSessionStore,
  getSandboxSessionSecret,
} from '@pagespace/lib/services/sandbox/machine-session-manager';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  checkMachineRuntimeGuardrail,
  recordMachineActivity,
} from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { defaultBuildEnv } from '@pagespace/lib/services/sandbox/tool-runners';
import { resolveGitHubTokenForSandbox } from '@pagespace/lib/services/sandbox/github-token';
import { isMachinePage } from '@pagespace/lib/content/page-types.config';
import type { PageType } from '@pagespace/lib/utils/enums';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { canUserEditPage, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { createDbMachineProjectStore } from '@pagespace/lib/services/machines/machine-projects-store';
import type { MachineActorContext, MachineProjectsDeps, MachineAcquireResult } from '@pagespace/lib/services/machines/machine-projects';
import type { PromoteProjectDeps } from '@pagespace/lib/services/machines/machine-project-promotion';
import { buildMachineBranchesDeps } from './machine-branches-runtime';
import { measureProjectStorageOpportunistically, measureMachineStorageOpportunistically } from '@pagespace/lib/services/sandbox/machine-storage-billing';

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one —
// @fly/sprites is ESM-only and @pagespace/lib compiles to CJS. Mirrors the
// same guard as apps/web/src/lib/ai/tools/sandbox-tools-runtime.ts.
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

// `createProductionSpritesSandboxClient` composes the raw Sprites SDK through
// `createSpriteMachineHost` + `createExecClientFromMachineHost` internally
// (apps/web/src/lib/sandbox/sprites-client.ts) — calling it here, rather than
// `sandbox-client/sprites.ts` directly, IS routing through the MachineHost seam.
let sandboxClientPromise: Promise<ExecSandboxClient> | null = null;
function getSandboxClient(): Promise<ExecSandboxClient> {
  sandboxClientPromise ??= (async () => {
    assertSandboxRuntime();
    const { createProductionSpritesSandboxClient } = await import('@/lib/sandbox/sprites-client');
    return createProductionSpritesSandboxClient();
  })().catch((error) => {
    sandboxClientPromise = null;
    throw error;
  });
  return sandboxClientPromise;
}

let machineSessionStorePromise: ReturnType<typeof createDbMachineSessionStore> | null = null;
function getMachineSessionStore() {
  machineSessionStorePromise ??= createDbMachineSessionStore();
  return machineSessionStorePromise;
}

let machineProjectStorePromise: ReturnType<typeof createDbMachineProjectStore> | null = null;
function getMachineProjectStore() {
  machineProjectStorePromise ??= createDbMachineProjectStore();
  return machineProjectStorePromise;
}

const VALID_TIERS: ReadonlySet<string> = new Set(['free', 'pro', 'founder', 'business']);
function toTier(value: string | null | undefined): SubscriptionTier {
  return value && VALID_TIERS.has(value) ? (value as SubscriptionTier) : 'free';
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
    tier: toTier(user?.subscriptionTier),
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

/** Edit-level access (add/remove) — re-checked on every acquire, not cached. */
export async function canAccessMachine(actorUserId: string, machineId: string): Promise<boolean> {
  const page = await findMachinePage(machineId);
  if (!page) return false;
  return canUserEditPage(actorUserId, machineId);
}

/** View-level access (list) — looser than edit-level. */
export async function canViewMachine(actorUserId: string, machineId: string): Promise<boolean> {
  const page = await findMachinePage(machineId);
  if (!page) return false;
  return canUserViewPage(actorUserId, machineId);
}

export function buildMachineProjectsDeps({ actorUserId }: { actorUserId: string }): MachineProjectsDeps {
  return {
    store: {
      list: async (machineId) => (await getMachineProjectStore()).list(machineId),
      findByName: async (machineId, name) => (await getMachineProjectStore()).findByName(machineId, name),
      findById: async (id) => (await getMachineProjectStore()).findById(id),
      promote: async (input) => (await getMachineProjectStore()).promote(input),
      create: async (input) => (await getMachineProjectStore()).create(input),
      remove: async (machineId, id) => (await getMachineProjectStore()).remove(machineId, id),
    },
    isEnabled: isCodeExecutionEnabled,
    now: () => new Date(),
    // See MachineProjectsDeps.newProjectId for why this is generated up front.
    newProjectId: createId,
    acquireMachineSandbox: async (machineId): Promise<MachineAcquireResult> => {
      const page = await db.query.pages.findFirst({
        where: eq(pages.id, machineId),
        columns: { driveId: true },
      });
      if (!page) return { ok: false, reason: 'not_found' };
      const drive = await db.query.drives.findFirst({
        where: eq(drives.id, page.driveId),
        columns: { ownerId: true },
      });
      if (!drive) return { ok: false, reason: 'error' };

      // Resume re-authz: re-verify edit access for the CURRENT actor on every
      // acquire, never trusting a permission check cached from an earlier request.
      const canRun = isCodeExecutionEnabled() && (await canAccessMachine(actorUserId, machineId));

      const nowMs = Date.now();
      if (canRun) {
        const guardrail = checkMachineRuntimeGuardrail({ machineKey: machineId, now: nowMs });
        if (!guardrail.allowed) return { ok: false, reason: guardrail.reason };
      }

      const result = await acquireMachineSession({
        pageId: machineId,
        driveId: page.driveId,
        tenantId: drive.ownerId,
        userId: actorUserId,
        canRun,
        deps: {
          store: await getMachineSessionStore(),
          client: await getSandboxClient(),
          now: () => new Date(),
          secret: getSandboxSessionSecret(),
          checkFullEgressEnablement: async () =>
            decideFullEgressEnablement({
              adminGateEnabled: isCodeExecutionEnabled(),
              containment: isContainmentVerified() ? { contained: true } : null,
            }),
        },
      });

      if (!result.ok) return { ok: false, reason: result.reason, cause: result.cause };
      recordMachineActivity({ machineKey: machineId, now: nowMs });
      return { ok: true, sandboxId: result.sandboxId, resumed: result.resumed };
    },
    reconnect: async (sandboxId) => (await getSandboxClient()).get({ sandboxId }),
    resolveGitHubToken: (userId) => resolveGitHubTokenForSandbox({ userId, db }),
    quota: {
      acquireSlot: acquireCodeExecutionSlot,
      releaseSlot: releaseCodeExecutionSlot,
    },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    killSprite: async ({ sandboxId, spriteInstanceId }) => {
      // Identity-guarded, best-effort: a failure is fine — the machine_projects
      // AFTER DELETE trigger rescues the pointer into the reclaim outbox and
      // the orphan reconciler retries. A replaced instance means our target is
      // already gone, which is the outcome we wanted.
      const [{ getMachineHostForBranches }, { MachineSpriteReplacedError }] = await Promise.all([
        import('./machine-branches-runtime'),
        import('@pagespace/lib/services/sandbox/machine-host'),
      ]);
      try {
        const host = await getMachineHostForBranches();
        await host.kill({ machineId: sandboxId, expectedInstanceId: spriteInstanceId ?? undefined });
        return { ok: true };
      } catch (error) {
        return { ok: error instanceof MachineSpriteReplacedError };
      }
    },
  };
}

/**
 * Production wiring for LAZY PROJECT-SPRITE PROMOTION
 * (`@pagespace/lib/services/machines/machine-project-promotion`).
 *
 * Promotion straddles both tiers, so this composes both wirings rather than
 * inventing a third: the project row + the OWNING Machine's Sprite come from
 * `buildMachineProjectsDeps` above (the dirty-tree check and the post-promotion
 * checkout reclaim run on the machine's own filesystem), while provisioning the
 * project's OWN Sprite and copying the Claude credential off the root Sprite
 * come from the Branches wiring's `MachineHost` seam + `resolveRootMachineHandle`
 * — the exact template promotion generalizes.
 */
export function buildPromoteProjectDeps({ actorUserId }: { actorUserId: string }): PromoteProjectDeps {
  const projects = buildMachineProjectsDeps({ actorUserId });
  const branches = buildMachineBranchesDeps();
  return {
    store: {
      findByName: projects.store.findByName,
      findById: projects.store.findById,
      promote: projects.store.promote,
    },
    isEnabled: projects.isEnabled,
    now: projects.now,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    host: branches.host,
    substrate: branches.substrate,
    options: branches.options,
    secret: branches.secret,
    checkFullEgressEnablement: branches.checkFullEgressEnablement,
    resolveGitHubToken: projects.resolveGitHubToken,
    resolveRootMachineHandle: branches.resolveRootMachineHandle,
    acquireMachineSandbox: projects.acquireMachineSandbox,
    reconnect: projects.reconnect,
    quota: projects.quota,
    buildEnv: projects.buildEnv,
    audit: projects.audit,
    // Storage attribution, inherited from the branch seam (issue #2204 phase 3):
    // while the promoted Sprite is awake for its own clone (or a reattach),
    // measure its used bytes onto its own `machine_projects` row so the storage
    // reconcile bills them to the OWNING Machine page. Throttled, best-effort,
    // and never wakes a hibernating Sprite. Without this a promotion would move
    // a project's bytes OFF the machine's measured filesystem and they would
    // stop being metered anywhere.
    measureProjectStorage: ({ machineProjectId, machinePageId, handle }) =>
      measureProjectStorageOpportunistically({ machineProjectId, machinePageId, handle }),
    // The other half of the same move (issue #2204 follow-up, F12): the bytes
    // left the ROOT when its checkout was reclaimed, so the root's stale
    // measurement must be refreshed or the reconcile bills them twice. Lazy
    // handle — the root Sprite may be hibernating, and `resolveHandle` is only
    // called once the measurement is known to be due.
    remeasureMachineStorage: ({ machinePageId }) =>
      measureMachineStorageOpportunistically({
        pageId: machinePageId,
        resolveHandle: () => branches.resolveRootMachineHandle(machinePageId),
        force: true,
      }),
  };
}
