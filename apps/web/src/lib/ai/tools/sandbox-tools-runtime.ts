/**
 * Production wiring for the agent code-execution tools.
 *
 * Binds the provider-agnostic factory (`createSandboxTools`) to the real
 * implementations: the session-anchored sandbox acquisition, the Fly Sprites
 * driver, the quota/concurrency surface, the call-time authz/quota gate, the
 * audit writer, and the chat-context → actor resolver. Kept in its own module
 * so the factory (and its tests) never import the backing-provider SDK
 * (`@fly/sprites` is ESM/node24-only).
 *
 * THE HANDLE SOURCE: `acquireSandbox` lazily ensures the conversation's agent
 * session row and its Sprite from `conversationId` alone — resolving
 * `conversations.workspaceId` to the session row it's bound to, NOT treating the
 * conversation id as a session id (contract.ts invariant 1: a session hosts
 * MANY conversations, and post-unconflation the two are different id
 * namespaces). This is one of the two sanctioned first-touch provisioning
 * sites (the other is a shell open). It runs through the SAME
 * `ensureSession`/`provisionSessionSandbox` path the API routes and the
 * realtime bridge use, so the CAS in `agent-workspace-sprite.ts` actually
 * serializes every concurrent provisioner.
 */

import type { Tool } from 'ai';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { drives, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { defaultBuildEnv, localRefusalToToolDenial, type SandboxRunDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  screenToolOutput,
  heuristicInjectionClassifier,
} from '@pagespace/lib/services/sandbox/injection-seam';
import { defaultSandboxBillingDeps } from '@pagespace/lib/services/sandbox/sandbox-billing';
import {
  isCheckpointBeforeAgentBatchEnabled,
  getCheckpointState,
  recordCheckpoint,
} from '@pagespace/lib/services/sandbox/checkpoint-policy';
import { parseLocalEnvSandboxId } from '@pagespace/lib/services/sandbox/sandbox-host';
import { adaptSandboxHandleToExecutableSandbox } from '@pagespace/lib/services/sandbox/sandbox-client/sandbox-host-adapter';
import { resolveSandboxHostForSandboxId } from '@/lib/agent-workspaces/sandbox-host-registry';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  checkSessionRuntimeGuardrail,
  recordSessionActivity,
} from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { gateSandboxToolCall } from '@pagespace/lib/services/sandbox/tool-gate';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { createSandboxTools, type ListReachableEnvironments, type ResolveEnvironmentTarget, type ResolveSandboxContext, type SandboxGate } from './sandbox-tools';
import { conversationMayReachPersistentEnvironments, decideEnvReach, ENV_UNREACHABLE_MESSAGE } from '@pagespace/lib/env-bridge/decide-env-reach';
import { OWN_SANDBOX_LABEL } from '@pagespace/lib/services/sandbox/environment-directory';
import type { SandboxEnvironmentTarget } from '@pagespace/lib/services/sandbox/tool-runners';
import {
  findSessionForConversation,
  provisionSessionSandbox,
  measureWarmSessionStorage,
  ensureGlobalSandboxSession,
  ensureEnvironmentSession,
  type AgentSessionRecord,
  type EnsureGlobalSandboxSessionFailureReason,
} from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import type { ToolExecutionContext } from '../core/types';
import { notifyShellAgentActivity } from '@/lib/websocket/socket-utils';

// The Sprites client is a process-wide stateless singleton, built lazily so
// importing this module does no SDK work at load.
let sandboxClientPromise: Promise<ExecSandboxClient> | null = null;

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

type ResolveOrProvisionResult =
  | { ok: true; session: AgentSessionRecord }
  /**
   * Nothing was ever attempted here — not a global conversation (or the
   * conversation doesn't exist). This is the ONLY failure shape safe to
   * treat as a permanent "no session, ever" — a page-agent conversation
   * denies the exact same way on every retry, forever.
   */
  | { ok: false; attempted: false }
  /**
   * A global conversation's auto-provision was ATTEMPTED and failed.
   * Deliberately carries the FULL `EnsureGlobalSandboxSessionFailureReason`
   * set, not a narrowed subset: every one of them (session cap, a transient
   * spawn fault, a lost claim) is racy or retryable by nature — a
   * concurrent sibling call, or a bare retry of THIS SAME call, can succeed
   * where this attempt didn't. Any caller that would otherwise treat
   * "attempted, failed" the same as "never attempted" reopens the exact
   * billing bypass two separate reviewer findings caught (P1 round 1:
   * session_limit_reached fell through unmetered; P1 round 2: spawn_failed
   * did too) — so this is a closed set on purpose, not narrowed to
   * whichever reason string the last bug happened to be about.
   */
  | { ok: false; attempted: true; reason: EnsureGlobalSandboxSessionFailureReason };

/**
 * Resolve a conversation's session, auto-provisioning one for a Global
 * Assistant conversation that has never had one — the ONE place this
 * decision is made, shared by `acquireSandbox` AND `resolveBillingSession`
 * below. Billing MUST see the same session (or the same absence of one)
 * `acquireSandbox` is about to act on: `resolveBillingSession` runs BEFORE
 * the credit gate, and its old "no session ⇒ nothing to bill, `run()` will
 * just deny" assumption broke the moment `acquireSandbox` stopped always
 * denying a session-less global conversation — a separate resolution there
 * would let a credit-exhausted caller's FIRST message auto-provision a
 * session and execute completely unmetered (review finding — P1, PR #2314).
 * Calling this same function from both call sites keeps them from ever
 * disagreeing about whether a session exists.
 */
async function resolveOrProvisionSession(
  conversationId: string,
  userId: string,
): Promise<ResolveOrProvisionResult> {
  const existing = await findSessionForConversation(conversationId);
  if (existing) return { ok: true, session: existing };

  // The default Global Assistant conversation is always minted session-less
  // (`resolveOrCreateConversation`) and nothing else ever claims it into
  // one — unlike page agents, which still require an explicit "New session"
  // spawn. Give it the same workspace that spawn would, automatically, the
  // first time it actually needs a sandbox — a REAL session (visible,
  // shareable with sibling panes exactly like any other), not a second
  // sandbox-only mechanism.
  const conversation = await conversationRepository.getConversation(conversationId);
  if (conversation?.type !== 'global') return { ok: false, attempted: false };

  const ensured = await ensureGlobalSandboxSession(conversationId, userId);
  if (ensured.ok) return { ok: true, session: ensured.session };
  return { ok: false, attempted: true, reason: ensured.reason };
}

/** Wire the real lib deps for the runners (session-anchored acquire + real Sprites driver). */
export function buildRealSandboxRunDeps(): SandboxRunDeps {
  return {
    isEnabled: isCodeExecutionEnabled,
    // The session-anchored acquisition: resolve the conversation's SESSION row,
    // then ensure its Sprite — both through the shared agent-sessions runtime,
    // never a local copy (the CAS only serializes provisioners that all run it).
    acquireSandbox: async (input) => {
      // Omission is never a default, at any layer. The schema makes a missing
      // `environmentId` a validation error the model sees, and this makes a
      // missing TARGET a refusal rather than a quiet fall-back to the
      // conversation's own sandbox — the exact shape July's `target` got wrong
      // in the other direction.
      const target = input.environment;
      if (!target) return { ok: false, reason: 'provision_failed', cause: 'missing_environment' };
      if (target.kind === 'environment') {
        // A named environment runs in ITS OWN session — found or spawned once
        // per (owner, environment), never this conversation's session
        // re-pointed at it. The spawn carries the owner-only bind gate for a
        // local env, so a refusal happens before any row exists.
        const ensured = await ensureEnvironmentSession({ ownerId: input.userId, envId: target.id });
        if (!ensured.ok) {
          // A refused BIND keeps its own typed word all the way to the agent —
          // "your computer is not connected" and "the machine owner's bind
          // policy denies you" are different problems with different owners.
          // This path adds no refusal vocabulary of its own.
          const refusal = ensured.refusal;
          if (refusal && !refusal.ok && refusal.reason === 'env_bind_refused') {
            const denial = localRefusalToToolDenial(refusal.refusal);
            if (denial) return { ok: false, reason: denial };
            return { ok: false, reason: 'provision_failed', cause: refusal.refusal };
          }
          return { ok: false, reason: 'provision_failed', cause: ensured.reason };
        }
        const row = ensured.session;
        const nowMs = Date.now();
        const guardrail = checkSessionRuntimeGuardrail({ workspaceId: row.id, now: nowMs });
        if (!guardrail.allowed) return { ok: false, reason: guardrail.reason };

        // The SAME provisioning path an env-bound session spawned from the
        // sidebar takes: the router inside `ensureAgentSessionSandbox` sees
        // `envId` and provisions the ENVIRONMENT, resolving the payer from the
        // env's own drive. A paused, revoked or policy-refusing environment
        // refuses here, through the existing sign/provision gate, with its
        // existing typed reason.
        const provisioned = await provisionSessionSandbox(row, input.userId);
        if (!provisioned.ok) {
          if (provisioned.reason === 'denied') {
            return provisioned.denial === 'not_authorized'
              ? { ok: false, reason: 'no_drive_access' }
              : { ok: false, reason: 'provision_failed', cause: provisioned.denial };
          }
          if (provisioned.reason === 'local_refused') {
            const denial = localRefusalToToolDenial(provisioned.refusal);
            if (denial) return { ok: false, reason: denial };
          }
          return { ok: false, reason: 'provision_failed', cause: provisioned.detail ?? provisioned.reason };
        }

        recordSessionActivity({ workspaceId: row.id, now: nowMs });
        return {
          ok: true,
          sandboxId: provisioned.sandboxId,
          resumed: provisioned.resumed,
          workspaceId: row.id,
          pageId: input.agentPageId,
        };
      }

      const conversationId = input.conversationId;
      if (!conversationId) {
        // No conversation, nothing to resolve a session through.
        // resolveSandboxActorContext already refuses this upstream.
        return { ok: false, reason: 'provision_failed', cause: 'missing_conversation_id' };
      }

      // The conversation's WORKING CONTEXT, through conversations.workspaceId.
      // A page conversation with no session gets a denial, never a
      // lazily-minted environment — per-conversation minting is exactly the
      // conflation the session model removed, and it is what made panes
      // unable to share a sandbox. A GLOBAL conversation is the one
      // exception: `resolveOrProvisionSession` auto-provisions it a real,
      // ordinary, shareable session (see its own doc). Every conversation in
      // one session resolves this same row, whose own id folds the ONE
      // Sprite key (review finding — CodeRabbit: this comment used to read
      // as a blanket invariant the auto-provisioning below it visibly
      // contradicts, which is exactly the kind of drift that gets the new
      // behavior "fixed" back out by a future reader trusting the comment).
      const resolved = await resolveOrProvisionSession(conversationId, input.userId);
      if (!resolved.ok) {
        if (!resolved.attempted) return { ok: false, reason: 'no_session' };
        return { ok: false, reason: 'provision_failed', cause: resolved.reason };
      }
      const row = resolved.session;

      // The per-sandbox continuous-runtime backstop, keyed by the SESSION id —
      // one budget per workspace, however many threads work in it.
      const nowMs = Date.now();
      const guardrail = checkSessionRuntimeGuardrail({ workspaceId: row.id, now: nowMs });
      if (!guardrail.allowed) return { ok: false, reason: guardrail.reason };

      const provisioned = await provisionSessionSandbox(row, input.userId);
      if (!provisioned.ok) {
        if (provisioned.reason === 'denied') {
          // `not_authorized` is the capability denial the runners already speak
          // (canRunCode's vocabulary); everything else is a provisioning fault.
          return provisioned.denial === 'not_authorized'
            ? { ok: false, reason: 'no_drive_access' }
            : { ok: false, reason: 'provision_failed', cause: provisioned.denial };
        }
        // A LOCAL env's refusal keeps its own vocabulary all the way to the
        // agent. Collapsing every one of them into `provision_failed` is the
        // defect this branch exists to prevent: "your computer is not
        // connected" (the requester fixes it in seconds with
        // `pagespace env connect`) and "the machine owner's bind policy denies
        // you" (only the owner can fix it, elsewhere) are different problems
        // with different owners, and an agent told the same sentence for both
        // debugs the wrong layer. Every OTHER local refusal is a provisioning
        // fault and keeps its detail.
        if (provisioned.reason === 'local_refused') {
          const denial = localRefusalToToolDenial(provisioned.refusal);
          if (denial) return { ok: false, reason: denial };
        }
        return { ok: false, reason: 'provision_failed', cause: provisioned.detail ?? provisioned.reason };
      }

      recordSessionActivity({ workspaceId: row.id, now: nowMs });

      return {
        ok: true,
        sandboxId: provisioned.sandboxId,
        resumed: provisioned.resumed,
        // The session the sandbox belongs to — what every post-run hook
        // (storage measurement, activity feed) is keyed by.
        workspaceId: row.id,
        // The CALLER's surface agent page (the conversation this run came
        // through) — purely descriptive per-agent attribution for the usage
        // breakdown, never a billing/payer key. A session hosts MANY
        // conversations (with any of the drive's agents, or the global
        // assistant) and has no agent page of its own; the payer is resolved
        // from the session's own driveId/ownerId (`resolveBillingSession`
        // below), never from this field.
        pageId: input.agentPageId,
      };
    },
    /**
     * Re-open the machine `acquireSandbox` just returned the address of.
     *
     * Routed through the host REGISTRY rather than straight at the Sprites
     * client, which is what makes an agent tool call reach a user's own
     * computer without a single change to any tool runner: the runner still
     * asks for an `ExecutableSandbox` by id and still drives `runCommand` /
     * `writeFiles` / `readFileToBuffer` on it. A local env holds no
     * `drive_envs.sandboxId` (invariant 9), so its address is derived
     * (`local-env:<envId>`) and the registry's parse — not a database read —
     * decides which substrate answers.
     *
     * The PRINCIPAL is bound here, from the acting request, because this is
     * the layer that has one: it is signed into every grant the machine
     * receives and it is what the owner's local ask prompt names.
     */
    reconnect: async (sandboxId, principal) => {
      if (parseLocalEnvSandboxId(sandboxId) === null) return (await getSandboxClient()).get({ sandboxId });
      const host = await resolveSandboxHostForSandboxId(sandboxId, {
        userId: principal.userId,
        sessionId: principal.workspaceId,
        conversationId: principal.conversationId,
      });
      const handle = await host.attach({ sandboxId });
      return handle === null ? null : adaptSandboxHandleToExecutableSandbox(handle);
    },
    quota: {
      acquireSlot: acquireCodeExecutionSlot,
      releaseSlot: releaseCodeExecutionSlot,
    },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    // Activity-visibility seam: stream a successful bash run into the live PTY
    // feed of every shell in this session, so a human watching one of them sees
    // what the agent just did on the sandbox they share. The realtime handler
    // for this has been in place (and tested) since the bridge re-key; this
    // wiring is what makes it reachable. Best-effort — `notifyShellAgentActivity`
    // logs and swallows its own errors, and the runner fires it unawaited.
    // Opportunistic storage measurement. Supplied HERE rather than called from
    // `acquireSandbox`, because the runner fires this seam from `release` — in a
    // `finally`, AFTER the op — and the timing is the whole point: measuring
    // before the op records the pre-write footprint and then lets the throttle
    // suppress the post-write one, so an agent that writes 5 GB stays invisible
    // until the throttle lapses. The seam's own comment says so; an earlier pass
    // of this PR wired a pre-op call anyway and reintroduced exactly that.
    measureStorage: ({ sandbox, workspaceId }) =>
      measureWarmSessionStorage({
        workspaceId,
        // The exec client exposes `runCommand`; the measurement seam speaks the
        // host's `exec`. One adapter here beats widening either contract.
        //
        // `spriteInstanceId` comes off THIS sandbox — the one the tool run
        // acquired and just used — because that is the disk `du` will walk.
        // Reading it from the session row instead would name whatever generation
        // is current at persist time, which is not necessarily this one.
        attach: async () => ({
          exec: (args) => sandbox.runCommand(args),
          spriteInstanceId: sandbox.spriteInstanceId,
        }),
      }),
    // `ShellActivityEventPayload.sessionId` is the web→realtime SHELL-BRIDGE
    // wire field. Realtime deploys before web on Fly, so renaming it would need
    // its own accept-both window; it is not part of this rename's inventory, so
    // the workspace id is mapped onto the existing wire name at the boundary.
    notifyShellActivity: ({ workspaceId, ...rest }) => notifyShellAgentActivity({ sessionId: workspaceId, ...rest }),
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
    // Meter this run's active-runtime cost against the SESSION's payer (its
    // own drive owner, or the session's own owner for a global-assistant
    // session) — never the caller's surface drive/agent page.
    billing: defaultSandboxBillingDeps,
    // Cheap billing-attribution resolve (`withMachineBilling` calls this
    // BEFORE gating, so a credit-exhausted payer is denied without waking a
    // hibernating sandbox): goes through the SAME `resolveOrProvisionSession`
    // `acquireSandbox` above uses, rather than a bare `findSessionForConversation`
    // read, so a session-less global conversation is auto-provisioned HERE,
    // before the credit gate — not down in `run()`, unmetered.
    //
    // `attempted: false` (never global, or the conversation doesn't exist) is
    // safe to fall through as `null` — nothing could ever auto-provision
    // here, so `acquireSandbox` will independently deny the exact same way,
    // on every retry, forever. `attempted: true` (a global conversation's
    // auto-provision was tried and failed) is NEVER safe to fall through,
    // for ANY of its reasons: every one is racy or retryable by nature (a
    // session-cap race, a transient spawn fault, a lost claim) — a
    // concurrent sibling call, or a bare retry of THIS SAME call, can
    // succeed where this attempt didn't. By the time `acquireSandbox` runs
    // moments later, that could already have happened — its own resolution
    // would then succeed and execute unmetered against a session billing
    // already gave up on. Fail the whole call closed instead of trusting a
    // second, independent resolution to agree with the first (review
    // findings — P1, PR #2314, both rounds: session_limit_reached fell
    // through unmetered first, then spawn_failed did too).
    resolveBillingSession: async (ctx) => {
      // A NAMED environment bills the ENVIRONMENT's drive, not the
      // conversation's (leaf D). That keeps a drive environment billed to that
      // drive's owner exactly as it is today when a session is spawned into it
      // from the sidebar — the conversation that happens to be driving it does
      // not change who pays. Resolved through the SAME find-or-spawn
      // `acquireSandbox` is about to use, so billing can never see a different
      // session from the one that runs.
      const target = ctx.environment;
      if (target?.kind === 'environment') {
        const ensured = await ensureEnvironmentSession({ ownerId: ctx.userId, envId: target.id });
        if (!ensured.ok) {
          return { deny: ensured.reason === 'session_limit_reached' ? 'session_limit_reached' : 'provision_failed' };
        }
        return { workspaceId: ensured.session.id, driveId: target.driveId, ownerId: ensured.session.ownerId };
      }
      if (!ctx.conversationId) return null;
      const resolved = await resolveOrProvisionSession(ctx.conversationId, ctx.userId);
      if (resolved.ok) {
        const row = resolved.session;
        return { workspaceId: row.id, driveId: row.driveId, ownerId: row.ownerId };
      }
      if (!resolved.attempted) return null;
      return { deny: resolved.reason === 'session_limit_reached' ? 'session_limit_reached' : 'provision_failed' };
    },
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

/**
 * Lazily stamp a stable turn id onto `context` the first time it's read, then
 * return it. `context` is the SAME object reference for every tool call
 * within one streamText run, so this stamps once per agent turn and every
 * later bash call in the run sees the value already set. Undefined `context`
 * (no tool-execution context at all) stays undefined — there is nothing to
 * stamp onto.
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
  /** The conversation's bound session (null = unbound) — the payer source for GLOBAL conversations. */
  findSessionForConversation: (
    conversationId: string,
  ) => Promise<{ driveId: string | null; ownerId: string } | null>;
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
  findSessionForConversation,
};

/**
 * Factory that creates the actor-context resolver with injected deps. The
 * default export (`resolveSandboxActorContext`) wires the real DB implementations;
 * pass fakes in tests.
 *
 * BOUND SESSION first, for every chat source — its driveId/ownerId are the
 * payer coordinates provisioning will actually use. Unbound conversations
 * fall back by chatSource.type:
 *  - global: the user (the driveless auto-spawn's payer-to-be).
 *  - page / undefined chatSource: the agent page's drive (this path only
 *    shapes the eventual no_session denial); no driveId fails closed.
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

    // Which drive/owner the sandbox will ACTUALLY charge and authorize
    // against: the conversation's BOUND SESSION first, for EVERY chat source
    // (review #2326, two rounds) — provisioning and billing key on the bound
    // session's own coordinates, so gating on anything else diverges:
    //
    //  - A GLOBAL conversation that is unbound gets a DRIVELESS session on
    //    its first tool call (`ensureGlobalSandboxSession` spawns
    //    `driveId: null`), so this user is the payer-to-be — never the
    //    drive they happen to be visiting.
    //  - A PAGE conversation can be hosted in a driveless Global session
    //    too (`create-conversation-in-workspace.ts`: a global session may
    //    host any accessible agent), where the payer is the SESSION's
    //    owner, not the agent's drive owner. Only an UNBOUND page
    //    conversation falls back to the agent/location drive — and that
    //    path never reaches provisioning (`resolveOrProvisionSession`
    //    denies session-less page conversations), so the fallback only
    //    shapes the denial, never a grant. No driveId fails closed; don't
    //    assume global intent when the source type is absent.
    const session = await deps.findSessionForConversation(conversationId);
    let driveId: string | undefined;
    let sessionOwnerId: string | undefined;
    if (session) {
      driveId = session.driveId ?? undefined;
      sessionOwnerId = session.ownerId;
    } else if (chatSourceType === 'global') {
      sessionOwnerId = userId;
    } else {
      driveId =
        context?.locationContext?.currentDrive?.id ??
        (context?.chatSource?.agentPageId
          ? await deps.findPageDriveId(context.chatSource.agentPageId)
          : undefined);
      if (!driveId) {
        return { error: 'Code execution requires an active drive.' };
      }
    }

    // `findDrive` only runs a real query when driveId is present (an
    // immediately-resolved undefined otherwise); it rides alongside
    // getActorInfo so both facts are in flight together.
    const [drive, actorInfo] = await Promise.all([
      driveId ? deps.findDrive(driveId) : Promise.resolve(undefined),
      deps.getActorInfo(userId),
    ]);
    if (driveId && !drive) return { error: 'Code execution requires an active drive.' };

    // The PAYER's tier, not the actor's (review #2326): the drive owner pays
    // for a drive-scoped session, the session's own owner for a driveless
    // global one — the same drive-owner ?? owner rule `canRunCode`'s tier
    // gate and billing already apply. Loading the ACTOR's tier here made
    // every quota check (`isSandboxAvailable` + the concurrency ceiling)
    // fail for a free-tier collaborator in a Pro-owned drive, despite
    // `canRunCode` having just authorized them against the payer. Sequenced
    // after the drive fetch because the payer's id IS the drive's owner.
    const payerId = drive?.ownerId ?? sessionOwnerId ?? userId;
    const payerRow = await deps.findUser(payerId);

    const base = {
      userId,
      conversationId,
      // Fail CLOSED: only an explicit `'global'` chat source is the dashboard
      // assistant. A page agent, and any surface that did not say what it is,
      // reads as `'page'` and cannot reach a persistent environment.
      conversationKind: chatSourceType === 'global' ? ('global' as const) : ('page' as const),
      requestOrigin: context?.requestOrigin,
      agentPageId: context?.chatSource?.agentPageId ?? context?.parentAgentId,
      actorEmail: actorInfo.actorEmail,
      actorDisplayName: actorInfo.actorDisplayName,
      aiProvider: context?.aiProvider,
      aiModel: context?.aiModel,
      tier: toSubscriptionTier(payerRow?.subscriptionTier),
      turnId,
    };

    // driveId present (a page agent's drive, or a global conversation bound
    // to a drive-scoped session): tenantId is the drive's owning account.
    // `ownerId` is the session's own owner where one is bound (global), else
    // the drive owner — either way the payer the call-time gate's
    // tier-eligibility check resolves against, never the acting user.
    if (driveId) {
      return { ...base, tenantId: drive!.ownerId, driveId, ownerId: sessionOwnerId ?? drive!.ownerId };
    }

    // Global AI with no (or a driveless) session: the session's owner is
    // their own isolation boundary. tenantId keeps the session key and quota
    // scopes user-owned; for the unbound case the payer-to-be is this user.
    return { ...base, tenantId: sessionOwnerId ?? userId, ownerId: sessionOwnerId ?? userId };
  };
}

/**
 * Resolve the actor context from the chat tool context. For page agents the
 * drive is the page's own; for the Global Assistant the coordinates come from
 * the conversation's bound session (else the driveless auto-spawn's owner —
 * this user). The tenant is the drive's owning account (the cloud tenant
 * boundary) and the quota tier is the PAYER's subscription tier.
 *
 * Global assistant context (chatSource.type === 'global') is a first-class path:
 * driveId may be absent and resolves with tenantId = userId.
 * Page AI (chatSource.type === 'page' or undefined) requires driveId — fail closed.
 */
export const resolveSandboxActorContext: ResolveSandboxContext =
  createResolveSandboxActorContext();

/**
 * The discovery read behind `list_environments` — both conditions (the caller
 * OWNS the machine, and it is visible to the global assistant) applied in SQL
 * by the store, never here. Loaded lazily so the chat pipeline does not import
 * the drive-env store at module load.
 *
 * **The environment gate is only consulted when local environments are
 * enabled.** With the flag off there are no reachable environments at all, so
 * the list is the conversation's own sandbox and nothing else — the same
 * answer the route gives as a 404, expressed as a list a model can read.
 */
export const productionListReachableEnvironments: ListReachableEnvironments = async (ctx) => {
  // The promise is about the GLOBAL assistant specifically — the column, the
  // settings toggle and the changelog all say so. A page agent gets its own
  // sandbox and nothing else, and never learns that a machine exists.
  if (!conversationMayReachPersistentEnvironments(ctx.conversationKind ?? 'page')) return [];
  const { isLocalEnvsEnabled } = await import('@pagespace/lib/services/drive-envs/local-envs-enabled');
  if (!isLocalEnvsEnabled()) return [];
  const { listGlobalAssistantEnvironments } = await import('@/lib/drive-envs/drive-envs-runtime');
  return listGlobalAssistantEnvironments(ctx.userId);
};

/**
 * Resolve the mandatory `environmentId` into the server's own target (leaf C).
 *
 * Two addresses, one namespace, and neither is guessable:
 *
 *  - the CONVERSATION's own id addresses its own sandbox — the address this
 *    runtime already resolves a session through (contract.ts invariant 1) —
 *    which is why the conversation's default sandbox is named exactly like any
 *    other environment and has no implicit path of its own;
 *  - any other id must be a `drive_envs.id` the caller may reach, decided by
 *    the pure `decideEnvReach`: it exists, they OWN it, and its owner has made
 *    it visible to the global assistant. All three refusals surface the SAME
 *    sentence, so an id that does not exist and one the caller may not see are
 *    indistinguishable from outside.
 *
 * Visibility is re-read HERE, on every call, rather than remembered from a
 * bind: switching it off refuses the next call instead of honouring an earlier
 * reach.
 *
 * The `label` on the returned target comes from the ROW, never from the model's
 * input, so leaf E's "every result names where it ran" cannot be steered by
 * what the model said.
 */
/**
 * The conversation's OWN sandbox as a resolved target (leaf C).
 *
 * Exported because the tools that are NOT addressed — the git/gh toolkit and
 * `copy_content`, which are deliberately fixed to the conversation's own
 * sandbox — share `buildRealSandboxRunDeps`, and `acquireSandbox` refuses
 * without a target. They say so explicitly here rather than relying on a
 * fallback: the whole point of leaf C is that no layer has one.
 */
export function ownSandboxTarget(ctx: { conversationId: string; driveId?: string }): SandboxEnvironmentTarget {
  return { id: ctx.conversationId, kind: 'conversation', label: OWN_SANDBOX_LABEL, driveId: ctx.driveId ?? null };
}

export const productionResolveEnvironmentTarget: ResolveEnvironmentTarget = async ({ ctx, environmentId }) => {
  if (environmentId === ctx.conversationId) {
    // The conversation's own sandbox keeps the conversation's own payer — the
    // coordinates `resolveSandboxActorContext` already resolved. Identity, not
    // a second resolution that could disagree with the first.
    return {
      ok: true,
      target: { id: environmentId, kind: 'conversation', label: OWN_SANDBOX_LABEL, driveId: ctx.driveId ?? null },
      // Its own coordinates, unchanged — including the drive it authorizes
      // against, which for the conversation's own sandbox is the drive it is in.
      payer: { driveId: ctx.driveId, ownerId: ctx.ownerId ?? ctx.userId, tenantId: ctx.tenantId, tier: ctx.tier, gateDriveId: ctx.driveId },
    };
  }
  // A page conversation is refused BEFORE the lookup — `decideEnvReach` owns the
  // rule, and this is it applied early so a page turn cannot probe for an id's
  // existence through timing or through a read it was never entitled to make.
  const kind = ctx.conversationKind ?? 'page';
  if (!conversationMayReachPersistentEnvironments(kind)) return { ok: false, error: ENV_UNREACHABLE_MESSAGE };

  const { isLocalEnvsEnabled } = await import('@pagespace/lib/services/drive-envs/local-envs-enabled');
  // With the flag off there are no reachable environments at all, and saying so
  // any other way would tell the caller whether the id exists.
  if (!isLocalEnvsEnabled()) return { ok: false, error: ENV_UNREACHABLE_MESSAGE };

  const { getDriveEnvStore } = await import('@/lib/drive-envs/drive-envs-runtime');
  const store = await getDriveEnvStore();
  const env = await store.findById(environmentId);
  // A local env's owner lives on the sibling; a Sprite env has none, which
  // `decideEnvReach` refuses (`not_owner`) rather than falling back to a role.
  const sibling = env === null ? null : await store.findLocalByEnvId(environmentId);
  const verdict = decideEnvReach({
    actorId: ctx.userId,
    conversationKind: kind,
    env: env === null ? null : { visibleToGlobalAssistant: env.visibleToGlobalAssistant, ownerId: sibling?.ownerId ?? null },
  });
  if (!verdict.ok) return { ok: false, error: ENV_UNREACHABLE_MESSAGE };

  // The PAYER is the ENVIRONMENT's drive owner, with no fallback — the same
  // rule `resolveDriveEnvPayer` applies to provisioning, so the gate, the
  // credit check and the provision cannot disagree about who is paying. A
  // vanished drive fails the call closed rather than charging the caller for a
  // machine the drive was going to pay for.
  const { resolveDriveEnvPayer } = await import('@/lib/drive-envs/drive-envs-runtime');
  const payer = await resolveDriveEnvPayer(env!.driveId);
  if (!payer) return { ok: false, error: ENV_UNREACHABLE_MESSAGE };
  return {
    ok: true,
    target: { id: env!.id, kind: 'environment', label: sibling?.label ?? env!.name, driveId: env!.driveId },
    payer: {
      driveId: env!.driveId,
      ownerId: payer.payerId,
      tenantId: payer.payerId,
      tier: payer.tier,
      // A LOCAL env authorizes on machine OWNERSHIP (already decided above,
      // and re-decided by `decideBind` at bind), so the drive-role leg does
      // not apply — otherwise the owner who left the drive is refused on every
      // call, on their own computer. Every other substrate keeps it.
      gateDriveId: env!.substrate === 'local' ? undefined : env!.driveId,
    },
  };
};

/**
 * The DISCOVERY gate: may this actor run ANYWHERE they can reach?
 *
 * The conversation's own coordinates first — the common case, and the cheapest.
 * If those refuse for any reason OTHER than the kill switch, the honest second
 * question is whether one of the environments they can reach would authorize
 * them, because that is the environment `openAt` will gate against when they
 * actually run. A free-tier person who owns a visible machine in a Pro-owned
 * drive is eligible there — `canRunCode`'s tier leg keys on the PAYER, and its
 * own docblock says so — and refusing them the ID of the only place they can
 * run made discovery the one surface that contradicted the rule (Codex P1,
 * #2616).
 *
 * The KILL SWITCH is never second-guessed: a disabled deployment refuses
 * discovery outright, and no environment can make it eligible.
 */
export const productionSandboxDiscoveryGate: SandboxGate = async (ctx) => {
  const direct = await productionSandboxGate(ctx);
  if (direct.ok || direct.reason === 'kill_switch_off') return direct;

  const reachable = await productionListReachableEnvironments(ctx);
  if (reachable.length === 0) return direct;

  const { resolveDriveEnvPayer } = await import('@/lib/drive-envs/drive-envs-runtime');
  for (const env of reachable) {
    const payer = await resolveDriveEnvPayer(env.driveId);
    if (!payer) continue;
    // The SAME shape `openAt` will gate the run with: the environment's payer,
    // and NO drive — a local env authorizes on machine ownership, which the
    // discovery listing has already established for every row it returned.
    const verdict = await gateSandboxToolCall({
      userId: ctx.userId,
      ownerId: payer.payerId,
      tenantId: payer.payerId,
      requestOrigin: ctx.requestOrigin,
      agentPageId: ctx.agentPageId,
      tier: payer.tier,
    });
    if (verdict.ok) return verdict;
  }
  return direct;
};

/** The shared call-time gate binding — kill-switch, canRunCode, quota preflight. */
export const productionSandboxGate: SandboxGate = (ctx) =>
  gateSandboxToolCall({
    userId: ctx.userId,
    driveId: ctx.driveId,
    ownerId: ctx.ownerId,
    tenantId: ctx.tenantId,
    requestOrigin: ctx.requestOrigin,
    agentPageId: ctx.agentPageId,
    tier: ctx.tier,
  });

/**
 * Production sandbox tools, fully wired. Registered behind the default-OFF
 * CODE_EXECUTION kill-switch — importing this object does not expose anything
 * by itself.
 */
export function buildSandboxTools(): {
  list_environments: Tool;
  bash: Tool;
  writeFile: Tool;
  readFile: Tool;
  editFile: Tool;
} {
  return createSandboxTools({
    runDeps: buildRealSandboxRunDeps(),
    resolveContext: resolveSandboxActorContext,
    gate: productionSandboxGate,
    gateDiscovery: productionSandboxDiscoveryGate,
    listEnvironments: productionListReachableEnvironments,
    resolveEnvironment: productionResolveEnvironmentTarget,
  });
}
