/**
 * Production wiring for the agent code-execution tools.
 *
 * Binds the provider-agnostic factory (`createSandboxTools`) to the real
 * implementations: the DB-backed session store, the Fly Sprites driver, the
 * quota/concurrency surface, the call-time authz/quota gate, the audit writer,
 * and the chat-context → actor resolver. Kept in its own module so the factory
 * (and its tests) never import the backing-provider SDK (`@fly/sprites` is
 * ESM/node24-only).
 *
 * Importing this module does not expose anything: PR4 calls `buildSandboxTools`
 * and registers the result behind the default-OFF feature flag.
 */

import type { Tool } from 'ai';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { drives, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { defaultBuildEnv, type SandboxRunDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { isCodeExecutionEnabled, canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  decideFullEgressEnablement,
  isContainmentVerified,
} from '@pagespace/lib/services/sandbox/containment';
import {
  screenToolOutput,
  heuristicInjectionClassifier,
} from '@pagespace/lib/services/sandbox/injection-seam';
import {
  getSandboxSessionSecret,
  createDbMachineSessionStore,
} from '@pagespace/lib/services/sandbox/machine-session-manager';
import { acquireMachineSandbox } from '@pagespace/lib/services/sandbox/machine-session';
import { acquireBranchSandbox } from '@pagespace/lib/services/sandbox/branch-session';
import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';
import { defaultSandboxBillingDeps } from '@pagespace/lib/services/sandbox/machine-billing';
import { measureMachineStorageOpportunistically } from '@pagespace/lib/services/sandbox/machine-storage-billing';
import { lookupPageOwnerId } from '@pagespace/lib/billing/machine-payer';
import {
  isCheckpointBeforeAgentBatchEnabled,
  getCheckpointState,
  recordCheckpoint,
} from '@pagespace/lib/services/sandbox/checkpoint-policy';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  checkMachineRuntimeGuardrail,
  recordMachineActivity,
} from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { gateSandboxToolCall } from '@pagespace/lib/services/sandbox/tool-gate';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isMachinePage } from '@pagespace/lib/content/page-types.config';
import { decideMachineToggleAccess } from '@pagespace/lib/services/machines/machine-access';
import type { MachineSettings } from '@pagespace/lib/services/machines/machine-settings';
import type { PageType } from '@pagespace/lib/utils/enums';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { createSandboxTools, type MachineDirectoryDeps, type ResolveSandboxContext } from './sandbox-tools';
import { canActorViewPage, getAgentPageId, hasAgentUserScopedAccess } from './actor-permissions';
import { pageAgentRepository, type MachineRef } from '@/lib/repositories/page-agent-repository';
import { globalMachineConfigRepository } from '@/lib/repositories/global-machine-config-repository';
import type { ToolExecutionContext } from '../core/types';
import { notifyTerminalAgentActivity } from '@/lib/websocket/socket-utils';

// The session store and Sprites client are process-wide singletons: the store
// reconnects to one DB pool and the client is stateless. Both are built lazily
// so importing this module does no DB or SDK work at load.
let storePromise: ReturnType<typeof createDbMachineSessionStore> | null = null;
let sandboxClientPromise: Promise<ExecSandboxClient> | null = null;

function getStore() {
  storePromise ??= createDbMachineSessionStore();
  return storePromise;
}

let branchStorePromise: ReturnType<typeof createDbMachineBranchStore> | null = null;

function getBranchStore() {
  branchStorePromise ??= createDbMachineBranchStore();
  return branchStorePromise;
}

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one.
// @fly/sprites is ESM-only and @pagespace/lib compiles to CJS, so a static
// import in lib would emit require('@fly/sprites') which Node rejects with
// ERR_REQUIRE_ESM. The factory lives in apps/web/src/lib/sandbox/sprites-client.ts
// instead, where Next.js handles the ESM import correctly. Deferring it here
// also keeps the SDK out of the module graph until code execution is actually
// invoked (only possible once the kill-switch is on).
const MIN_SANDBOX_NODE_MAJOR = 24;

// Deferring the import only protects the OFF path; the ENABLED path still has to
// run on a compatible runtime. Fail CLOSED with an actionable message if a
// Node < 24 process tries to load the SDK, so flipping the flag on a Node 22
// image surfaces the deployment gate ("run the sandbox driver on Node 24+")
// instead of a cryptic ESM/engine failure deep inside the SDK.
function assertSandboxRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < MIN_SANDBOX_NODE_MAJOR) {
    throw new Error(
      `Agent code execution requires Node.js >= ${MIN_SANDBOX_NODE_MAJOR} ` +
        `(the @fly/sprites SDK is Node ${MIN_SANDBOX_NODE_MAJOR}+ / ESM-only); ` +
        `this process is Node ${process.versions.node}. Run the sandbox driver on a ` +
        `Node ${MIN_SANDBOX_NODE_MAJOR}+ runtime before enabling code execution.`,
    );
  }
}

function getSandboxClient(): Promise<ExecSandboxClient> {
  sandboxClientPromise ??= (async () => {
    assertSandboxRuntime();
    const { createProductionSpritesSandboxClient } = await import('@/lib/sandbox/sprites-client');
    return createProductionSpritesSandboxClient();
  })().catch((error) => {
    // Never memoize a rejection: a transient lazy-load failure (or a fixable
    // runtime/version misconfiguration) must not poison every later
    // code-execution request in this process until a restart. Clear the cache so
    // the next call retries the import.
    sandboxClientPromise = null;
    throw error;
  });
  return sandboxClientPromise;
}

/** Wire the real lib deps for the runners (DB-backed store + real Sprites driver). */
export function buildRealSandboxRunDeps(): SandboxRunDeps {
  return {
    isEnabled: isCodeExecutionEnabled,
    // Branch-scoped "PageSpace Agent" panes (issue #2166 phase 8) route to the
    // attach-only branch seam instead of the machine's own persistent
    // session — a branch's Sprite is provisioned exclusively by the
    // branch-spawn path, never lazily here.
    acquireSandbox: async ({ branchSandbox, ...input }) =>
      branchSandbox
        ? acquireBranchSandbox({
            driveId: input.driveId,
            userId: input.userId,
            requestOrigin: input.requestOrigin,
            agentPageId: input.agentPageId,
            machineId: branchSandbox.machineId,
            machineBranchId: branchSandbox.machineBranchId,
            deps: {
              authorize: canRunCode,
              now: () => new Date(),
              checkMachineRuntimeGuardrail,
              recordMachineActivity,
              findBranch: async (machineBranchId) => (await getBranchStore()).findById(machineBranchId),
            },
          })
        : acquireMachineSandbox({
            ...input,
            deps: {
              store: await getStore(),
              client: await getSandboxClient(),
              authorize: canRunCode,
              now: () => new Date(),
              secret: getSandboxSessionSecret(),
              // Full-egress G-gate: the agent sandbox runs OPEN egress, so refuse to
              // provision unless containment is verified for the live topology
              // (SANDBOX_CONTAINMENT_VERIFIED=true after the G1 probes pass). Admin
              // gate has precedence. Fail-closed when unset.
              checkFullEgressEnablement: async () =>
                decideFullEgressEnablement({
                  adminGateEnabled: isCodeExecutionEnabled(),
                  containment: isContainmentVerified() ? { contained: true } : null,
                }),
              checkMachineRuntimeGuardrail,
              recordMachineActivity,
            },
          }),
    reconnect: async (sandboxId) => (await getSandboxClient()).get({ sandboxId }),
    quota: {
      acquireSlot: acquireCodeExecutionSlot,
      releaseSlot: releaseCodeExecutionSlot,
    },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    // Activity-visibility seam (Terminal Epic 1 T1.5): stream a successful bash
    // run into the referenced Terminal's live PTY feed. Best-effort — errors are
    // handled inside notifyTerminalAgentActivity itself (logged, never thrown).
    notifyTerminalActivity: (input) =>
      notifyTerminalAgentActivity({
        tenantId: input.tenantId,
        driveId: input.driveId,
        pageId: input.pageId,
        command: input.command,
        output: input.output,
        exitCode: input.exitCode,
        agentLabel: input.agentLabel,
      }),
    // Injection seam (DEFENSE-IN-DEPTH, fail-open): screen untrusted tool output
    // through the built-in heuristic classifier before it becomes a model message.
    // Annotates flagged content (never blocks); a classifier error fails open. A
    // model-based classifier can replace `heuristicInjectionClassifier` here.
    screenOutput: (text) =>
      screenToolOutput({
        text,
        classifier: heuristicInjectionClassifier,
        onFlagged: (verdict) =>
          loggers.ai.warn?.('Sandbox tool output flagged by injection seam (annotated, not blocked)', {
            label: verdict.label,
          }),
        onError: (error) =>
          loggers.ai.error(
            'Sandbox injection classifier errored (failing open)',
            error instanceof Error ? error : new Error(String(error)),
          ),
      }),
    now: () => new Date(),
    logger: loggers.ai,
    // Terminal Epic 3: meter this run's active-runtime cost against the machine's
    // payer (the drive owner by default — see resolveMachinePayerId).
    billing: defaultSandboxBillingDeps,
    // Sprites Platform Alignment 6-1: while the sprite is awake for this op,
    // opportunistically (throttled, best-effort) measure its used storage bytes
    // so the storage reconcile bills MEASURED usage — never waking a paused one.
    // ExecutableSandbox.runCommand shares MachineHandle.exec's signature.
    measureStorage: ({ sandbox, pageId }) =>
      measureMachineStorageOpportunistically({
        handle: { exec: (args) => sandbox.runCommand(args) },
        pageId,
      }),
    // Sprites Platform Alignment 5-2: checkpoint the sandbox filesystem before
    // an agent bash batch runs (fail-open, at most once per turn — see
    // checkpoint-policy.ts). State is in-process, keyed by sandboxId; a
    // process restart simply re-checkpoints on the next batch, which is
    // harmless (COW, ~300ms).
    checkpoint: {
      isEnabled: isCheckpointBeforeAgentBatchEnabled,
      getState: getCheckpointState,
      recordCheckpoint,
      createCheckpoint: ({ sandbox, comment }) => sandbox.createCheckpoint(comment),
    },
  };
}

const VALID_TIERS: ReadonlySet<string> = new Set(['free', 'pro', 'founder', 'business']);

function toTier(value: string | null | undefined): SubscriptionTier {
  return value && VALID_TIERS.has(value) ? (value as SubscriptionTier) : 'free';
}

/**
 * Lazily stamp a stable turn id onto `context` the first time it's read, then
 * return it. `context` is the SAME object reference for every tool call
 * within one streamText run (see `ToolExecutionContext.activeMachine`'s doc —
 * same guarantee, same mutate-in-place pattern), so this stamps once per
 * agent turn and every later bash call in the run sees the value already set.
 * Undefined `context` (no tool-execution context at all) stays undefined —
 * there is nothing to stamp onto.
 */
function stampTurnId(context: ToolExecutionContext | undefined): string | undefined {
  if (!context) return undefined;
  context.turnId ??= crypto.randomUUID();
  return context.turnId;
}

/**
 * IO dependencies for resolving the sandbox actor context. Injected so the
 * function can be unit-tested without a real database connection.
 */
export interface ResolveSandboxActorContextDeps {
  findDrive: (driveId: string) => Promise<{ ownerId: string } | undefined>;
  findPageDriveId: (pageId: string) => Promise<string | undefined>;
  findUser: (userId: string) => Promise<{ subscriptionTier: string | null } | undefined>;
  getActorInfo: (userId: string) => Promise<{ actorEmail: string; actorDisplayName?: string }>;
}

const defaultResolveDeps: ResolveSandboxActorContextDeps = {
  findDrive: (driveId) =>
    db.query.drives.findFirst({ where: eq(drives.id, driveId), columns: { ownerId: true } }),
  findPageDriveId: async (pageId) => {
    const row = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true },
    });
    return row?.driveId ?? undefined;
  },
  findUser: (userId) =>
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { subscriptionTier: true } }),
  getActorInfo,
};

/**
 * Factory that creates the actor-context resolver with injected deps. The
 * default export (`resolveSandboxActorContext`) wires the real DB implementations;
 * pass fakes in tests.
 *
 * Discriminates by chatSource.type BEFORE checking driveId — three cases:
 *  - driveId present (page or global): look up drive.ownerId for tenantId.
 *  - page / undefined chatSource, no driveId: fail closed.
 *  - global, no driveId: tenantId = userId (user is their own isolation boundary).
 */
export function createResolveSandboxActorContext(
  deps: ResolveSandboxActorContextDeps = defaultResolveDeps,
): ResolveSandboxContext {
  return async (context) => {
    const userId = context?.userId;
    const conversationId = context?.conversationId;
    if (!userId) return { error: 'Code execution requires an authenticated user.' };
    if (!conversationId) return { error: 'Code execution requires a conversation.' };

    const turnId = stampTurnId(context);
    const chatSourceType = context?.chatSource?.type;
    const driveId =
      context?.locationContext?.currentDrive?.id ??
      (
        chatSourceType === 'page' && context?.chatSource?.agentPageId
          ? await deps.findPageDriveId(context.chatSource.agentPageId)
          : undefined
      );

    // Page AI (or undefined chatSource) with no driveId — fail closed. Don't
    // assume global intent when the source type is absent.
    if (chatSourceType !== 'global' && !driveId) {
      return { error: 'Code execution requires an active drive.' };
    }

    // One parallel fetch covers both branches below: `findDrive` only runs a
    // real query when driveId is present (an immediately-resolved undefined
    // otherwise), so this preserves the original concurrency — findDrive,
    // findUser, and getActorInfo all in flight together — without duplicating
    // the actor lookup + result-object construction per branch.
    const [drive, actorRow, actorInfo] = await Promise.all([
      driveId ? deps.findDrive(driveId) : Promise.resolve(undefined),
      deps.findUser(userId),
      deps.getActorInfo(userId),
    ]);
    if (driveId && !drive) return { error: 'Code execution requires an active drive.' };

    const base = {
      userId,
      conversationId,
      requestOrigin: context?.requestOrigin,
      agentPageId: context?.chatSource?.agentPageId ?? context?.parentAgentId,
      actorEmail: actorInfo.actorEmail,
      actorDisplayName: actorInfo.actorDisplayName,
      aiProvider: context?.aiProvider,
      aiModel: context?.aiModel,
      tier: toTier(actorRow?.subscriptionTier),
      turnId,
    };

    // driveId present for both page AI and global AI: tenantId is the drive's
    // owning account. Both surfaces share identical resolution logic here.
    if (driveId) {
      return { ...base, tenantId: drive!.ownerId, driveId };
    }

    // Global AI without a drive: user is their own isolation boundary.
    // tenantId = userId keeps the session key and quota scopes user-owned.
    // Side-effect: the tenant quota bucket becomes code-exec:tenant:<userId>,
    // a second user-keyed window alongside code-exec:user:<userId>. This
    // over-counts conservatively (only tightens budget) and is acceptable while
    // the feature is admin-gated. Revisit if tenant-scope quota semantics matter.
    return { ...base, tenantId: userId };
  };
}

/**
 * Resolve the actor context from the chat tool context. The drive comes from the
 * active location; the tenant is the drive's owning account (the cloud tenant
 * boundary); the concurrency tier is the acting user's subscription tier.
 *
 * Global assistant context (chatSource.type === 'global') is a first-class path:
 * driveId may be absent and resolves with tenantId = userId.
 * Page AI (chatSource.type === 'page' or undefined) requires driveId — fail closed.
 */
export const resolveSandboxActorContext: ResolveSandboxContext =
  createResolveSandboxActorContext();

/**
 * The page row the machine directory needs: identity/routing fields plus the
 * two Machine Settings access toggles (their canonical shape/docs live on
 * `MachineSettings` in @pagespace/lib machines/machine-settings.ts).
 */
export type MachineDirectoryPage = {
  title: string;
  type: string;
  driveId: string;
  isTrashed: boolean;
} & Pick<MachineSettings, 'allowPageAgents' | 'visibleToGlobalAssistant'>;

/**
 * IO dependencies for the machine directory. Injected so it can be unit-tested
 * without a real database connection.
 */
export interface MachineDirectoryRuntimeDeps {
  findPage: (pageId: string) => Promise<MachineDirectoryPage | undefined>;
  canViewPage: (rawContext: ToolExecutionContext, pageId: string) => Promise<boolean>;
  /** `PageAgentConfig.machineAccess`/`machines` — the canonical config source. */
  getAgentConfig: (agentPageId: string) => Promise<{ machineAccess: boolean; machines: MachineRef[] } | null>;
  /** The global assistant's user-level parallel of `getAgentConfig` (globalAssistantConfig). */
  getGlobalConfig: (userId: string) => Promise<{ machineAccess: boolean; machines: MachineRef[] }>;
  /** Lazily provision (or reuse) the personal Terminal page backing a user's global "own" machine. */
  getOrCreateOwnMachinePageId: (userId: string) => Promise<string>;
  /** A page's owning drive's `ownerId` — the same lookup `resolveMachinePayerId` uses for billing attribution. */
  lookupPageOwnerId: (pageId: string) => Promise<string | null>;
  /**
   * Whether the page agent identified by `ownAgentPageId` (its OWN chatSource
   * agent id — NOT a sub-agent's `parentAgentId`) has opted into user-scoped
   * reach (`pages.userScopedAccess`). Mirrors the exact seam `canActorViewPage`
   * already uses (`resolveActingAgentId`/`hasAgentUserScopedAccess` in
   * actor-permissions.ts): such an agent acts with the INVOKING USER's own
   * reach for view permissions, so it is exempt from the `allowPageAgents`
   * toggle too — that toggle targets narrower, embedded page agents, not a
   * personal/global-style assistant a user already has full page access to.
   */
  isUserScopedAgent: (ownAgentPageId: string) => Promise<boolean>;
}

const defaultMachineDirectoryDeps: MachineDirectoryRuntimeDeps = {
  findPage: async (pageId) =>
    db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: {
        title: true,
        type: true,
        driveId: true,
        isTrashed: true,
        allowPageAgents: true,
        visibleToGlobalAssistant: true,
      },
    }),
  canViewPage: canActorViewPage,
  getAgentConfig: (agentPageId) => pageAgentRepository.getAgentById(agentPageId),
  getGlobalConfig: (userId) => globalMachineConfigRepository.getConfig(userId),
  getOrCreateOwnMachinePageId: (userId) => globalMachineConfigRepository.getOrCreateOwnMachinePageId(userId),
  lookupPageOwnerId,
  isUserScopedAgent: hasAgentUserScopedAccess,
};

/**
 * Resolves the global assistant's configured machine list: gated by the
 * user's own `machineAccess` (default off → no machines), same as a page
 * agent. Its 'own' machine has no agent page to serve as its identity
 * (machine-session.ts's resolveMachinePageId doc comment), so it is resolved
 * transparently here into the user's lazily-provisioned personal Terminal
 * page — everything downstream (routing, permissions, activity) then treats
 * it exactly like any other 'existing' machine.
 *
 * Machines hidden by `visibleToGlobalAssistant` are deliberately NOT filtered
 * here: `isMachineAccessible` is the single policy site (it denies them with
 * the toggle's reason on every call, so list_machines omits them,
 * switch_machine explains them, and resolveActiveMachine's accessible-first
 * fallback skips them as a default).
 */
async function resolveGlobalConfiguredMachines(
  userId: string,
  deps: MachineDirectoryRuntimeDeps,
): Promise<MachineRef[]> {
  const config = await deps.getGlobalConfig(userId);
  if (!config.machineAccess) return [];
  const configured = config.machines.length > 0 ? config.machines : [{ kind: 'own' as const }];
  return Promise.all(
    configured.map(async (m) =>
      m.kind === 'own'
        ? { kind: 'existing' as const, machineId: await deps.getOrCreateOwnMachinePageId(userId) }
        : m,
    ),
  );
}

/**
 * Resolves an agent's configured machine list for `listMachines`. A page
 * agent's list is gated by `machineAccess` (default off → no machines);
 * `machines[0]` is the default active machine, falling back to 'own' if
 * `machineAccess` is on but no machine has been configured yet. No
 * `agentPageId` means the global assistant — see resolveGlobalConfiguredMachines.
 */
async function resolveConfiguredMachines(
  agentPageId: string | undefined,
  userId: string | undefined,
  deps: MachineDirectoryRuntimeDeps,
): Promise<MachineRef[]> {
  if (agentPageId) {
    const agent = await deps.getAgentConfig(agentPageId);
    if (!agent?.machineAccess) return [];
    return agent.machines.length > 0 ? agent.machines : [{ kind: 'own' }];
  }
  if (!userId) return [];
  return resolveGlobalConfiguredMachines(userId, deps);
}

function activeMachineAgentPageId(rawContext: ToolExecutionContext | undefined): string | undefined {
  return rawContext?.chatSource?.agentPageId ?? rawContext?.parentAgentId;
}

/**
 * Factory for the machine directory, with injected deps for testing. The
 * default export (`machineDirectory`) wires the real DB.
 */
export function createMachineDirectory(
  deps: MachineDirectoryRuntimeDeps = defaultMachineDirectoryDeps,
): MachineDirectoryDeps {
  return {
    listMachines: (rawContext) => {
      // A machine-bound "PageSpace Agent" pane (issue #2166 phase 7): the
      // binding IS the entitlement (established by the route's page-edit
      // check before deriveMachinePaneBinding ran), so the agent's/global
      // assistant's own configured machine list is never consulted — the
      // bound machine is the ONLY machine this run may ever see or switch to.
      if (rawContext?.machineBinding) {
        return Promise.resolve([{ kind: 'existing' as const, machineId: rawContext.machineBinding.self.machineId }]);
      }
      return resolveConfiguredMachines(activeMachineAgentPageId(rawContext), rawContext?.userId, deps);
    },
    describeMachine: async (_rawContext, machine) => {
      if (machine.kind === 'own') return { name: 'My Machine' };
      const page = await deps.findPage(machine.machineId);
      return { name: page?.title ?? 'Terminal' };
    },
    isMachineAccessible: async (rawContext, machine) => {
      // A page agent's 'own' machine is keyed off its own AI_CHAT page
      // (resolveMachinePageId, machine-session.ts) — not a MACHINE page, so
      // there are no Settings toggles to consult. The global assistant's
      // 'own' machine never reaches here as 'own': it is resolved into an
      // 'existing' ref (resolveGlobalConfiguredMachines) and fully checked.
      if (machine.kind === 'own') return { allowed: true };
      if (!rawContext) return { allowed: false };
      const page = await deps.findPage(machine.machineId);
      if (!page || page.isTrashed || !isMachinePage(page.type as PageType)) return { allowed: false };
      const canView = await deps.canViewPage(rawContext, machine.machineId);
      if (!canView) return { allowed: false };
      // A machine-bound "PageSpace Agent" pane (issue #2166 phase 7): the
      // pane's OWN bound machine is exempt from the Settings-toggle decision
      // below — same rationale as the user-scoped-agent exemption just below
      // (the binding IS the entitlement, established by the route's
      // page-edit check before deriveMachinePaneBinding ran) — but existence/
      // trash/type/canActorViewPage above are NEVER bypassed. A DIFFERENT
      // machine (e.g. an attempted switch_machine away from the bound
      // checkout) still gets the full toggle check below.
      if (rawContext.machineBinding?.self.machineId === machine.machineId) return { allowed: true };
      // Machine access toggles (Settings tab): pure policy in @pagespace/lib
      // machines/machine-access.ts. An agentPageId — the agent's own page or
      // the parent's for a sub-agent — marks the actor page-scoped; without
      // one the actor is the global assistant (the SAME discriminator
      // resolveConfiguredMachines uses to pick whose machine list applies).
      // EXCEPT: a page agent with userScopedAccess=true acts with the
      // INVOKING USER's own reach for view permissions (canActorViewPage,
      // just checked above, already resolved through that fallthrough) — such
      // an agent is exempt from BOTH toggles. It isn't literally the global
      // assistant (visibleToGlobalAssistant would apply an unrelated gate:
      // its machine list comes from its own agent config, not
      // globalMachineConfigRepository), so it bypasses the toggle decision
      // entirely rather than being reclassified as 'global-assistant'.
      // Checked AFTER canViewPage so a toggle reason (which names the
      // machine) is never surfaced to an actor who can't view the page.
      const ownAgentPageId = rawContext ? getAgentPageId(rawContext) : undefined;
      const isUserScoped = ownAgentPageId ? await deps.isUserScopedAgent(ownAgentPageId) : false;
      if (isUserScoped) return { allowed: true };
      const actor = activeMachineAgentPageId(rawContext) ? ('page-agent' as const) : ('global-assistant' as const);
      const decision = decideMachineToggleAccess({ actor, settings: page });
      if (!decision.allowed) {
        return {
          allowed: false,
          code: decision.code,
          reason:
            decision.code === 'page_agents_disabled'
              ? `The machine "${page.title}" does not allow page agents ("Allow page agents" is turned off in its settings), so this agent cannot run terminal tools on it.`
              : `The machine "${page.title}" is not visible to the global assistant ("Visible to global assistant" is turned off in its settings).`,
        };
      }
      return { allowed: true };
    },
    resolveDriveId: async (_rawContext, machine, ambientDriveId) => {
      if (machine.kind === 'own') return ambientDriveId;
      const page = await deps.findPage(machine.machineId);
      return page?.driveId ?? ambientDriveId;
    },
    resolveTenantId: async (_rawContext, machine, ambientTenantId) => {
      if (machine.kind === 'own') return ambientTenantId;
      const ownerId = await deps.lookupPageOwnerId(machine.machineId);
      return ownerId ?? ambientTenantId;
    },
  };
}

export const machineDirectory: MachineDirectoryDeps = createMachineDirectory();

/**
 * Production sandbox tools, fully wired. Exported for PR4 to register behind the
 * default-OFF feature flag — importing this object does not expose anything by
 * itself.
 */
export function buildSandboxTools(): {
  bash: Tool;
  writeFile: Tool;
  readFile: Tool;
  editFile: Tool;
  switch_machine: Tool;
  list_machines: Tool;
} {
  return createSandboxTools({
    runDeps: buildRealSandboxRunDeps(),
    resolveContext: resolveSandboxActorContext,
    gate: (ctx) =>
      gateSandboxToolCall({
        userId: ctx.userId,
        driveId: ctx.driveId,
        tenantId: ctx.tenantId,
        requestOrigin: ctx.requestOrigin,
        agentPageId: ctx.agentPageId,
        tier: ctx.tier,
      }),
    machines: machineDirectory,
  });
}
