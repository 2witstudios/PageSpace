/**
 * Agent Workspaces API — ONE flat route family (`/api/agent-workspaces/**`),
 * deliberately NOT nested under page-agents/conversations: a workspace is a
 * DRIVE-level working context hosting many conversations (contract.ts
 * invariant 1), so no single agent or conversation exists to nest it under.
 * Auth derives from the workspace row's drive.
 *
 * The `route: 'agent-sessions'` value in the audit details below is
 * DELIBERATELY not renamed: audit rows are an append-only record and existing
 * queries/alerts match on that literal. Renaming it would split one route's
 * history into two names — which is a different failure from the one this
 * epic's rename fixes.
 *
 * GET ?driveId=<id> | (none = mine)
 *   → { sessions: [{ …AgentSessionDTO, shells: ShellDTO[], conversations }] }
 * POST { driveId, agentPageId, name?, firstThing? }
 *   → 201 { session, conversationId } | { session, shellId, shellName } — spawn (see below)
 *
 * Every listing is scoped to the REQUESTER's own sessions (`ownerId` rides
 * every filter): `driveId` narrows *where*, never *whose*. Open to every
 * authenticated user — sessions/chat/panes are free; only the sandbox
 * itself (real cloud compute) is tier-gated, inside `canRunCode` /
 * `CODE_EXECUTION` further down the call chain, not at this listing level.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, canPrincipalViewPage } from '@/lib/auth';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createId } from '@paralleldrive/cuid2';
import {
  checkAccessForSubject,
  claimConversationInSession,
  countActiveSessionsForOwner,
  createConversationInSession,
  endSession,
  findSessionRecord,
  listSessions,
  listSessionConversationsBulk,
  MAX_ACTIVE_SESSIONS_PER_OWNER,
  provisionSessionSandbox,
  spawnSession,
  toAgentSessionDTO,
  type AgentSessionListFilter,
} from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { listShellsBulk, spawnShell } from '@/lib/agent-workspaces/workspace-shells-runtime';
import { findWorkspaceOfConversation } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { readWorkspaceNodesBulk } from '@/lib/agent-workspaces/workspace-node-runtime';
import { sessionQuotaExceeded } from '@/lib/agent-workspaces/quota-response';

/** Bound on the stored display label — rendered everywhere the session appears. */
const MAX_SESSION_NAME_LENGTH = 120;

/**
 * A blank-name spawn's auto-label: the first collision-free of `base`,
 * `base 2`, `base 3`, … — mirroring `nextShellLabel`'s "count existing,
 * append a number, scan past collisions" pattern
 * (`plan-spawn-worker.ts:61-68`), but starting at the bare label rather than
 * always suffixing a number: no session is ever born "Shell 1".
 */
function nextUniqueSessionName(base: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

/**
 * The `canPrincipalViewPage` gate every agent-permission check in this route
 * shares — same denial shape, same audit payload, whether the agent came
 * from the ordinary mint path's `agentPageId` or a claim's own conversation
 * row. Factored out because this exact check→audit→403 sequence appeared
 * verbatim at two call sites in this file (review finding — reuse pass).
 * Returns the ready 403 response on denial, or `null` when the caller may
 * proceed.
 */
async function denyIfCannotViewAgent(
  request: Request,
  auth: Parameters<typeof canPrincipalViewPage>[0],
  agentPageId: string,
): Promise<NextResponse | null> {
  const canView = await canPrincipalViewPage(auth, agentPageId);
  if (canView) return null;
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId: auth.userId,
    resourceType: 'page_agent_conversation',
    resourceId: agentPageId,
    details: { reason: 'no_view_permission', method: 'POST', route: 'agent-sessions' },
    riskScore: 0.5,
  });
  return NextResponse.json({ error: 'Insufficient permissions to use this agent' }, { status: 403 });
}

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const driveId = url.searchParams.get('driveId');

  // No agent filter exists any more: a session hosts conversations with MANY
  // agents, so "an agent's sessions" is not a real relation to query.
  const filter: AgentSessionListFilter =
    driveId !== null && driveId.length > 0
      ? { driveId, ownerId: auth.userId }
      : { ownerId: auth.userId };

  try {
    const sessions = await listSessions(filter);
    // Children in THREE bulk queries, however many sessions listed — this is
    // polled by every open sidebar, and the per-session shape was 1+2N
    // queries per poll (review M4).
    const workspaceIds = sessions.map((session) => session.workspaceId);
    const [shellsBySession, conversationsBySession, nodesBySession] = await Promise.all([
      listShellsBulk(workspaceIds),
      listSessionConversationsBulk(workspaceIds),
      // THE NODE TREE, one per listed session — the sidebar's own source now
      // that it renders the live tree out of the store instead of a polled
      // grid snapshot. One statement for one workspace and for fifty, and the
      // titles are resolved once per viewer beside the nodes, never inside
      // them.
      readWorkspaceNodesBulk(workspaceIds, auth.userId),
    ]);
    const withChildren = sessions.map((session) => {
      // Every workspace ASKED FOR has an entry; this fallback covers only a
      // session that vanished between `listSessions` and the node read. An
      // empty tree at rev 0 is the honest answer for it, and the same one a
      // never-written workspace gets — the client seats both identically.
      const tree = nodesBySession.get(session.workspaceId) ?? { rev: 0, nodes: [], targets: [] };
      return {
        ...session,
        shells: shellsBySession.get(session.workspaceId) ?? [],
        // THE list of threads in this workspace, and there is nothing left to
        // annotate it with (issue #2373). Membership IS the node row, so each
        // entry carries its `nodeId` — read off the same row that decided the
        // thread is here at all.
        //
        // `annotateConversationsWithPanes` existed to reconcile this listing
        // with a separate grid, and it is deleted rather than ported: a listing
        // and a grid that come from one table cannot disagree, so there is no
        // correspondence left to maintain. Every entry here is on screen, which
        // is why the `attached` boolean that used to ride beside `nodeId` is
        // gone too: a thread in this list is in the tree, and the tree is what
        // the grid draws.
        conversations: conversationsBySession.get(session.workspaceId) ?? [],
        // THE TREE. `{rev, nodes, targets}` — the same shape `GET
        // /[workspaceId]/nodes` answers, so the sidebar's seat and a pane
        // surface's own read are one function on the client, not two.
        rev: tree.rev,
        nodes: tree.nodes,
        targets: tree.targets,
      };
    });
    return NextResponse.json({ sessions: withChildren });
  } catch (error) {
    loggers.api.error(
      'Agent sessions list failed',
      error instanceof Error ? error : undefined,
      { driveId },
    );
    return NextResponse.json({ error: 'Failed to list agent sessions' }, { status: 500 });
  }
}

/**
 * POST → 201 { session, conversationId } | { session, shellId } — SPAWN a session.
 *
 * One act, per the lifecycle invariant: a session is born with its first
 * thing, so this creates the workspace row AND that first thing already bound
 * to it. Three shapes:
 *
 * - `{ driveId, agentPageId }` — a DRIVE session, first conversation with that
 *   drive agent.
 * - `{ driveId }` (`agentPageId` null/omitted) — a DRIVE session whose first
 *   conversation is the assistant instead of a specific agent. The
 *   conversation and access layers don't care whether a null-agent
 *   conversation's session has a drive (`createConversationInSession`'s
 *   `agentPageId: null` branch and `decideAgentSessionAccess` both key only
 *   on `driveId`) — a drive session can already host such a conversation via
 *   the split-pane picker, this just allows it as the FIRST thing too.
 * - `{}` (both null/omitted) — a GLOBAL-ASSISTANT session: no drive, first
 *   conversation is a `type: 'global'` assistant thread. Owner-only by the
 *   access decision (there is no drive whose membership could admit anyone
 *   else).
 *
 * `firstThing: 'shell'` swaps the first-conversation act for a first-shell
 * one: the session's first thing is a shell instead, reusing the exact
 * sandbox-provisioning + shell-spawn logic the shells route uses
 * (`provisionSessionSandbox` + `spawnShell`) rather than reimplementing it.
 *
 * `firstThing: 'claim', conversationId` swaps it again for claiming an
 * EXISTING, never-session-bound conversation the caller owns as the
 * session's first thing, instead of minting a brand-new one —
 * `claimConversationInSession` (`claim-conversation-in-workspace.ts`), the
 * ONE place `conversations.workspaceId` is ever written. `driveId`/`agentPageId`
 * are derived from the claimed row itself (a `type: 'page'` row's own agent;
 * a `type: 'global'` row takes the caller's `driveId`, same three-shape
 * ambiguity as the ordinary mint path below) — a caller-supplied
 * `agentPageId` alongside `firstThing: 'claim'` is refused outright.
 *
 * Omitted/anything else behaves exactly as before — the conversation path.
 *
 * Only one shape is refused outright: an `agentPageId` without a `driveId` is
 * unresolvable (which drive's agent?) — UNLESS `firstThing: 'shell'` or
 * `'claim'`, neither of which take an `agentPageId` from the caller at all.
 *
 * A blank/omitted `name` is not left null: it is auto-derived from the spawn
 * target (the agent's title, "Shell", or "Global Assistant") and made unique
 * among the owner's own existing session names before the row is inserted.
 *
 * Spawn itself is instant and free: NO sandbox is provisioned for the
 * conversation path. `firstThing: 'shell'` is the exception — opening a shell
 * always needs a live sandbox, so this branch provisions eagerly instead of
 * waiting for the first tool call.
 *
 * Access: the same pure decision every session surface uses, applied to the
 * row-to-be — drive membership + code-execution for a drive session, owner +
 * code-execution for a global one.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: {
    driveId?: unknown;
    agentPageId?: unknown;
    name?: unknown;
    firstThing?: unknown;
    conversationId?: unknown;
  } = {};
  try {
    body = await request.json();
  } catch {
    // Body is required — a spawn names its drive and agent.
  }
  let driveId = typeof body.driveId === 'string' && body.driveId.length > 0 ? body.driveId : null;
  const agentPageId =
    typeof body.agentPageId === 'string' && body.agentPageId.length > 0 ? body.agentPageId : null;
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const wantsShellFirst = body.firstThing === 'shell';
  const wantsClaim = body.firstThing === 'claim';
  const claimConversationId =
    typeof body.conversationId === 'string' && body.conversationId.length > 0 ? body.conversationId : null;

  if (wantsClaim && claimConversationId === null) {
    return NextResponse.json(
      { error: 'A claim needs the conversation to claim' },
      { status: 400 },
    );
  }
  if (wantsClaim && agentPageId !== null) {
    // The agent is a property of the CLAIMED ROW, not the request — derived
    // below from the conversation itself, never taken from the caller.
    return NextResponse.json(
      { error: 'An agent cannot be supplied when claiming an existing conversation' },
      { status: 400 },
    );
  }

  if (!wantsShellFirst && !wantsClaim && driveId === null && agentPageId !== null) {
    // The only truly unresolvable shape: an agent without its drive. Every
    // other combination is valid — both-present (drive session with that
    // agent), drive-only (drive session, assistant-first), and both-null
    // (global-assistant session). A shell-first spawn needs no agent, and a
    // claim's agent (if any) is derived from the claimed row, so both are
    // exempt from this check entirely.
    return NextResponse.json(
      { error: 'An agent needs its drive to start a session' },
      { status: 400 },
    );
  }

  // The agent's title, when one is being spawned into — the base label a
  // blank `name` derives from (see below). Captured here rather than
  // re-fetched, since the lookup already happened for validation.
  let agentTitle: string | null = null;
  // The claimed conversation's own title/type, for name derivation below —
  // only ever set on the `wantsClaim` path.
  let claimTitle: string | null = null;
  let claimIsGlobal = false;

  if (wantsClaim) {
    // conversationId is non-null here (validated above); TS can't see that
    // through the closure, so re-derive a narrowed local.
    const conversationId = claimConversationId as string;
    const row = await conversationRepository.getConversation(conversationId);
    if (!row || row.userId !== auth.userId || !row.isActive) {
      // Uniform "not found" whether the id never existed, belongs to someone
      // else, or was history-deleted — an id-guessing caller learns nothing.
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
    // MEMBERSHIP, from the tree — one lookup on the node table's global
    // chat-target index. An ADVISORY preflight: the claim's own decision asks
    // the same question, and the unique index settles the racing case, so this
    // exists to answer the ordinary one before a workspace row is minted.
    if ((await findWorkspaceOfConversation(conversationId)) !== null) {
      return NextResponse.json(
        { error: 'That conversation already belongs to a session' },
        { status: 409 },
      );
    }
    claimTitle = row.title;

    if (row.type === 'page') {
      if (!row.contextId) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }
      const agent = await conversationRepository.getAiAgent(row.contextId);
      if (!agent) {
        return NextResponse.json({ error: 'AI agent not found' }, { status: 404 });
      }
      // The drive is DERIVED from the agent, never taken from the body — a
      // caller-supplied drive that disagrees is refused rather than
      // silently overridden.
      if (driveId !== null && driveId !== agent.driveId) {
        return NextResponse.json(
          { error: "That conversation's agent belongs to a different drive" },
          { status: 400 },
        );
      }
      driveId = agent.driveId;
      const denied = await denyIfCannotViewAgent(request, auth, row.contextId);
      if (denied) return denied;
      agentTitle = agent.title;
    } else if (row.type === 'global') {
      claimIsGlobal = true;
      // driveId stays whatever the caller (the surface's own drive context)
      // sent — the same three-shape ambiguity the ordinary mint path already
      // documents: a global thread may legitimately open in a drive-scoped
      // or a global session, and only the caller knows which.
    } else {
      // 'client' (API-managed) rows have no in-app viewer and can't be
      // claimed — same policy `resolveNavigationTarget` already applies.
      return NextResponse.json({ error: 'That conversation is not available' }, { status: 409 });
    }
  }

  if (agentPageId !== null && driveId !== null) {
    // The same checks the conversation routes make, BEFORE any row is minted
    // (review M6): the page must BE an agent, the requester must be allowed
    // to see it, and it must live in the drive being spawned into — the
    // central binding gate would refuse the mismatch anyway, but failing here
    // means no session row is created and then rolled back.
    const agent = await conversationRepository.getAiAgent(agentPageId);
    if (!agent) {
      return NextResponse.json({ error: 'AI agent not found' }, { status: 404 });
    }
    if (agent.driveId !== driveId) {
      return NextResponse.json(
        { error: 'That agent belongs to a different drive than this session' },
        { status: 400 },
      );
    }
    const denied = await denyIfCannotViewAgent(request, auth, agentPageId);
    if (denied) return denied;
    agentTitle = agent.title;
  }

  // Advisory fast-path only (review #2261/2): count-then-branch here is
  // TOCTOU-racy on its own — N concurrent POSTs could all read under the
  // ceiling — so it exists to skip the agent lookups below for the OBVIOUS
  // over-limit case. `spawnSession` enforces the ceiling ATOMICALLY (a
  // per-owner advisory lock around the count-and-insert in the store), and is
  // the authoritative check the `spawned.reason === 'session_limit_reached'`
  // branch below maps.
  const activeCount = await countActiveSessionsForOwner(auth.userId);
  if (activeCount >= MAX_ACTIVE_SESSIONS_PER_OWNER) {
    return sessionQuotaExceeded(request, auth.userId, null, 'agent-sessions', {
      message: `You have ${activeCount} active sessions — end some before starting more.`,
    });
  }

  const access = await checkAccessForSubject(auth.userId, {
    ownerId: auth.userId,
    driveId,
  });
  if (!access.allowed) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: driveId ?? 'global',
      details: { reason: access.reason, method: 'POST', route: 'agent-sessions' },
      riskScore: 0.5,
    });
    return NextResponse.json(
      { error: driveId ? 'You cannot start a session in this drive' : 'You cannot start an assistant session' },
      { status: 403 },
    );
  }

  // A label, never an address — but still bounded: it is stored, listed and
  // rendered everywhere the session appears. Blank/omitted does not stay
  // null: it is derived from the spawn target and made unique among the
  // owner's own existing session names, so the sidebar never renders the
  // literal fallback "Session" for a spawn that went through this route.
  let name: string;
  if (rawName.length > 0) {
    name = rawName.slice(0, MAX_SESSION_NAME_LENGTH);
  } else {
    const baseLabel = wantsShellFirst
      ? 'Shell'
      : wantsClaim
        // A page claim with no title anywhere must fall back to 'Agent', not
        // 'Global Assistant' — that terminal fallback is for the GLOBAL
        // claim case only (review finding — CodeRabbit: a titleless page
        // claim was misnaming a drive-scoped session "Global Assistant").
        ? (claimTitle?.trim() || (claimIsGlobal ? 'Global Assistant' : (agentTitle ?? 'Agent')))
        : agentPageId !== null
          ? (agentTitle ?? 'Agent')
          : 'Global Assistant';
    const existingSessions = await listSessions({ ownerId: auth.userId });
    const existingNames = existingSessions.map((session) => session.name);
    name = nextUniqueSessionName(baseLabel, existingNames).slice(0, MAX_SESSION_NAME_LENGTH);
  }

  const spawned = await spawnSession({ userId: auth.userId, driveId, name });
  if (!spawned.ok) {
    if (spawned.reason === 'session_limit_reached') {
      // The atomic backstop caught what the pre-check above missed — a
      // concurrent spawn landed between the pre-check and here.
      return sessionQuotaExceeded(request, auth.userId, null, 'agent-sessions', {
        message: 'You have reached your active session limit — end some before starting more.',
      });
    }
    loggers.api.error('Agent session spawn failed', undefined, { driveId, detail: spawned.detail });
    return NextResponse.json({ error: 'Could not start a session', reason: spawned.reason }, { status: 502 });
  }

  if (wantsShellFirst) {
    // The first shell — same provisioning + spawn pair the shells route uses
    // (`[workspaceId]/shells/route.ts` POST, lines 88-167): a shell always
    // needs a live sandbox, so unlike the conversation path this provisions
    // eagerly rather than waiting for the first tool call.
    const provisioned = await provisionSessionSandbox(spawned.session, auth.userId);
    if (!provisioned.ok) {
      await endSession(spawned.session.id).catch(() => {});
      // A plan-limit refusal is not an infrastructure failure — same split the
      // shells route draws (`[workspaceId]/shells/route.ts` POST): a live-sandbox
      // quota denial gets the actionable 429, not a generic 502.
      if (provisioned.reason === 'denied' && provisioned.denial === 'session_limit_reached') {
        return sessionQuotaExceeded(request, auth.userId, spawned.session.id, 'agent-sessions', {
          reasonCode: provisioned.detail,
        });
      }
      if (provisioned.reason === 'denied') {
        // The provisioner's own authorization refused — an entitlement fact,
        // not an infrastructure failure, so it must not read as a 502. Since
        // the session surface opened to every drive member, a free-tier payer
        // legitimately reaches this shell-first path; name the plan gate.
        auditRequest(request, {
          eventType: 'authz.access.denied',
          userId: auth.userId,
          resourceType: 'agent_session',
          resourceId: spawned.session.id,
          details: {
            reason: provisioned.denial ?? 'denied',
            ...(provisioned.detail ? { detail: provisioned.detail } : {}),
            method: 'POST',
            route: 'agent-sessions',
          },
          riskScore: 0.5,
        });
        return NextResponse.json(
          {
            error:
              provisioned.detail === 'tier_ineligible'
                ? 'Running the agent sandbox requires a Pro plan or above'
                : 'You cannot open a terminal in this drive',
          },
          { status: 403 },
        );
      }
      loggers.api.error(
        'Agent session spawn: first shell sandbox provision failed',
        undefined,
        { workspaceId: spawned.session.id, reason: provisioned.reason },
      );
      return NextResponse.json({ error: 'Could not start a session' }, { status: 502 });
    }

    const shellSpawned = await spawnShell({ workspaceId: spawned.session.id, ownerId: auth.userId });
    if (!shellSpawned.ok) {
      // The session row exists but its first shell failed: end it rather than
      // leave an empty workspace the model says cannot exist.
      await endSession(spawned.session.id).catch(() => {});
      loggers.api.error(
        'Agent session spawn: first shell failed',
        undefined,
        { workspaceId: spawned.session.id, reason: shellSpawned.reason },
      );
      return NextResponse.json({ error: 'Could not start a session' }, { status: 502 });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: spawned.session.id,
      details: { op: 'spawn_session', driveId, agentPageId: null, shellId: shellSpawned.shell.shellId },
    });

    // spawned.session is the PRE-provision row — provisioning just flipped its
    // sandbox state, so refetch rather than report the stale 'none' status a
    // caller would otherwise read off the DTO it just successfully spawned.
    const provisionedSession = (await findSessionRecord(spawned.session.id)) ?? spawned.session;

    return NextResponse.json(
      {
        session: toAgentSessionDTO(provisionedSession),
        shellId: shellSpawned.shell.shellId,
        shellName: shellSpawned.shell.name,
      },
      { status: 201 },
    );
  }

  if (wantsClaim) {
    // The first thing is an EXISTING conversation, not a new one — claim it
    // into the just-spawned session instead of minting a fresh row. Response
    // shape is deliberately identical to the ordinary mint path below, so
    // the client has one success handler for both.
    const conversationId = claimConversationId as string;
    const outcome = await claimConversationInSession({
      conversationId,
      userId: auth.userId,
      workspaceId: spawned.session.id,
    });
    if (outcome !== 'claimed' && outcome !== 'already_in_session') {
      // The session row exists but its first (claimed) conversation failed:
      // end it rather than leave an empty workspace the model says cannot
      // exist. `session_full` is unreachable by construction (a session that
      // was just spawned has zero conversations) — folded into the generic
      // refusal rather than special-cased.
      await endSession(spawned.session.id).catch(() => {});
      if (outcome === 'cross_drive_denied') {
        loggers.api.error(
          'Agent session spawn: claim of first conversation failed (cross-drive)',
          undefined,
          { workspaceId: spawned.session.id, conversationId },
        );
        return NextResponse.json({ error: 'That conversation is not available' }, { status: 400 });
      }
      if (outcome === 'not_found') {
        // The preflight above already refused every non-racy cause of
        // `not_found` (missing, foreign, inactive, already bound elsewhere)
        // with its own 409/404 — reaching it HERE means the identical
        // condition changed underneath us in the gap between that read and
        // this atomic claim (most likely: another request claimed it first).
        // Same conflict, same status the preflight gives it — not a server
        // fault, so not 502.
        return NextResponse.json(
          { error: 'That conversation is no longer available to claim' },
          { status: 409 },
        );
      }
      loggers.api.error(
        'Agent session spawn: claim of first conversation failed',
        undefined,
        { workspaceId: spawned.session.id, conversationId, outcome },
      );
      return NextResponse.json({ error: 'Could not start a session' }, { status: 502 });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: spawned.session.id,
      details: { op: 'spawn_session', claimed: true, driveId, conversationId },
    });

    return NextResponse.json(
      { session: toAgentSessionDTO(spawned.session), conversationId },
      { status: 201 },
    );
  }

  // The first conversation — the session is never empty. Created through the
  // squat-guarded path, already bound to the session.
  const conversationId = createId();
  try {
    await createConversationInSession({
      conversationId,
      userId: auth.userId,
      agentPageId,
      workspaceId: spawned.session.id,
    });
  } catch (error) {
    // The session row exists but its first conversation failed: end it rather
    // than leave an empty workspace the model says cannot exist.
    await endSession(spawned.session.id).catch(() => {});
    loggers.api.error(
      'Agent session spawn: first conversation failed',
      error instanceof Error ? error : undefined,
      { workspaceId: spawned.session.id },
    );
    return NextResponse.json({ error: 'Could not start a session' }, { status: 502 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: spawned.session.id,
    details: { op: 'spawn_session', driveId, agentPageId, conversationId },
  });

  return NextResponse.json(
    { session: toAgentSessionDTO(spawned.session), conversationId },
    { status: 201 },
  );
}
