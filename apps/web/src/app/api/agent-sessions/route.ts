/**
 * Agent Sessions API — ONE flat route family (`/api/agent-sessions/**`),
 * deliberately NOT nested under page-agents/conversations: a session is a
 * DRIVE-level workspace hosting many conversations (contract.ts invariant 1),
 * so no single agent or conversation exists to nest it under. Auth derives
 * from the session row's drive.
 *
 * GET ?driveId=<id> | (none = mine)
 *   → { sessions: [{ …AgentSessionDTO, shells: ShellDTO[], conversations }] }
 * POST { driveId, agentPageId, name?, firstThing? }
 *   → 201 { session, conversationId } | { session, shellId, shellName } — spawn (see below)
 *
 * Every listing is scoped to the REQUESTER's own sessions (`ownerId` rides
 * every filter): `driveId` narrows *where*, never *whose*. Admin gate first,
 * 403 without enumerating anything — the agents surface is admin-only +
 * CODE_EXECUTION (the population the retired machines surface served).
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, canPrincipalViewPage } from '@/lib/auth';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createId } from '@paralleldrive/cuid2';
import {
  checkAccessForSubject,
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
} from '@/lib/agent-sessions/agent-sessions-runtime';
import { listShellsBulk, spawnShell } from '@/lib/agent-sessions/session-shells-runtime';
import { getSessionWorkspacesBulk } from '@/lib/agent-sessions/session-workspace-runtime';
import { sessionQuotaExceeded } from '@/lib/agent-sessions/quota-response';

/** Bound on the stored display label — rendered everywhere the session appears. */
const MAX_SESSION_NAME_LENGTH = 120;

/**
 * A blank-name spawn's auto-label: the first collision-free of `base`,
 * `base 2`, `base 3`, … — mirroring `nextShellLabel`'s "count existing,
 * append a number, scan past collisions" pattern
 * (`plan-spawn-session.ts:61-68`), but starting at the bare label rather than
 * always suffixing a number: no session is ever born "Shell 1".
 */
function nextUniqueSessionName(base: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const driveId = url.searchParams.get('driveId');

  if (auth.role !== 'admin') {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: driveId ? 'drive' : 'agent_sessions',
      resourceId: driveId ?? undefined,
      details: { reason: 'app_admin_required', method: 'GET', route: 'agent-sessions' },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'Agent sessions require administrator privileges' }, { status: 403 });
  }

  // No agent filter exists any more: a session hosts conversations with MANY
  // agents, so "an agent's sessions" is not a real relation to query.
  const filter: AgentSessionListFilter =
    driveId !== null && driveId.length > 0
      ? { driveId, ownerId: auth.userId }
      : { ownerId: auth.userId };

  try {
    const sessions = await listSessions(filter);
    // Children in TWO bulk queries, however many sessions listed — this is
    // polled by every open sidebar, and the per-session shape was 1+2N
    // queries per poll (review M4).
    const sessionIds = sessions.map((session) => session.sessionId);
    const [shellsBySession, conversationsBySession, workspaceBySession] = await Promise.all([
      listShellsBulk(sessionIds),
      listSessionConversationsBulk(sessionIds),
      getSessionWorkspacesBulk(sessionIds),
    ]);
    const withChildren = sessions.map((session) => ({
      ...session,
      shells: shellsBySession.get(session.sessionId) ?? [],
      // The sidebar's expansion list: the threads living in this workspace.
      conversations: conversationsBySession.get(session.sessionId) ?? [],
      // The sidebar's PANE-grouped expansion list, once it exists — `null`
      // for a session never opened under `useWorkspaceServerSync`, which the
      // sidebar reads as "fall back to the flat conversation list above."
      workspace: workspaceBySession.get(session.sessionId) ?? null,
    }));
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
 * Omitted/anything else behaves exactly as before — the conversation path.
 *
 * Only one shape is refused: an `agentPageId` without a `driveId` is
 * unresolvable (which drive's agent?) — UNLESS `firstThing: 'shell'`, whose
 * first thing needs no agent at all.
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

  let body: { driveId?: unknown; agentPageId?: unknown; name?: unknown; firstThing?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // Body is required — a spawn names its drive and agent.
  }
  const driveId = typeof body.driveId === 'string' && body.driveId.length > 0 ? body.driveId : null;
  const agentPageId =
    typeof body.agentPageId === 'string' && body.agentPageId.length > 0 ? body.agentPageId : null;
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const wantsShellFirst = body.firstThing === 'shell';

  if (!wantsShellFirst && driveId === null && agentPageId !== null) {
    // The only truly unresolvable shape: an agent without its drive. Every
    // other combination is valid — both-present (drive session with that
    // agent), drive-only (drive session, assistant-first), and both-null
    // (global-assistant session). A shell-first spawn needs no agent, so it
    // is exempt from this check entirely.
    return NextResponse.json(
      { error: 'An agent needs its drive to start a session' },
      { status: 400 },
    );
  }

  // The agent's title, when one is being spawned into — the base label a
  // blank `name` derives from (see below). Captured here rather than
  // re-fetched, since the lookup already happened for validation.
  let agentTitle: string | null = null;

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
    const canView = await canPrincipalViewPage(auth, agentPageId);
    if (!canView) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'page_agent_conversation',
        resourceId: agentPageId,
        details: { reason: 'no_view_permission', method: 'POST', route: 'agent-sessions' },
        riskScore: 0.5,
      });
      return NextResponse.json(
        { error: 'Insufficient permissions to use this agent' },
        { status: 403 },
      );
    }
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
    return sessionQuotaExceeded(request, auth.userId, 'about-to-be-minted', 'agent-sessions', {
      message: `You have ${activeCount} active sessions — end some before starting more.`,
    });
  }

  const access = await checkAccessForSubject(auth.userId, {
    sessionId: 'about-to-be-minted',
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
    const baseLabel = wantsShellFirst ? 'Shell' : agentPageId !== null ? (agentTitle ?? 'Agent') : 'Global Assistant';
    const existingSessions = await listSessions({ ownerId: auth.userId });
    const existingNames = existingSessions.map((session) => session.name);
    name = nextUniqueSessionName(baseLabel, existingNames).slice(0, MAX_SESSION_NAME_LENGTH);
  }

  const spawned = await spawnSession({ userId: auth.userId, driveId, name });
  if (!spawned.ok) {
    if (spawned.reason === 'session_limit_reached') {
      // The atomic backstop caught what the pre-check above missed — a
      // concurrent spawn landed between the pre-check and here.
      return sessionQuotaExceeded(request, auth.userId, 'about-to-be-minted', 'agent-sessions', {
        message: 'You have reached your active session limit — end some before starting more.',
      });
    }
    loggers.api.error('Agent session spawn failed', undefined, { driveId, detail: spawned.detail });
    return NextResponse.json({ error: 'Could not start a session', reason: spawned.reason }, { status: 502 });
  }

  if (wantsShellFirst) {
    // The first shell — same provisioning + spawn pair the shells route uses
    // (`[sessionId]/shells/route.ts` POST, lines 88-167): a shell always
    // needs a live sandbox, so unlike the conversation path this provisions
    // eagerly rather than waiting for the first tool call.
    const provisioned = await provisionSessionSandbox(spawned.session, auth.userId);
    if (!provisioned.ok) {
      await endSession(spawned.session.id).catch(() => {});
      // A plan-limit refusal is not an infrastructure failure — same split the
      // shells route draws (`[sessionId]/shells/route.ts` POST): a live-sandbox
      // quota denial gets the actionable 429, not a generic 502.
      if (provisioned.reason === 'denied' && provisioned.denial === 'session_limit_reached') {
        return sessionQuotaExceeded(request, auth.userId, spawned.session.id, 'agent-sessions', {
          reasonCode: provisioned.detail,
        });
      }
      loggers.api.error(
        'Agent session spawn: first shell sandbox provision failed',
        undefined,
        { sessionId: spawned.session.id, reason: provisioned.reason },
      );
      return NextResponse.json({ error: 'Could not start a session' }, { status: 502 });
    }

    const shellSpawned = await spawnShell({ sessionId: spawned.session.id, ownerId: auth.userId });
    if (!shellSpawned.ok) {
      // The session row exists but its first shell failed: end it rather than
      // leave an empty workspace the model says cannot exist.
      await endSession(spawned.session.id).catch(() => {});
      loggers.api.error(
        'Agent session spawn: first shell failed',
        undefined,
        { sessionId: spawned.session.id, reason: shellSpawned.reason },
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

  // The first conversation — the session is never empty. Created through the
  // squat-guarded path, already bound to the session.
  const conversationId = createId();
  try {
    await createConversationInSession({
      conversationId,
      userId: auth.userId,
      agentPageId,
      sessionId: spawned.session.id,
    });
  } catch (error) {
    // The session row exists but its first conversation failed: end it rather
    // than leave an empty workspace the model says cannot exist.
    await endSession(spawned.session.id).catch(() => {});
    loggers.api.error(
      'Agent session spawn: first conversation failed',
      error instanceof Error ? error : undefined,
      { sessionId: spawned.session.id },
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
