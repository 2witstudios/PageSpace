/**
 * Contract tests for /api/ai/conversations/[conversationId]/plan.
 *
 * This is the read side of the durable plan binding, so the obligations under
 * test are the ones that would leak or lose data if they regressed: a
 * conversation belonging to someone else must be indistinguishable from one that
 * does not exist, a plan the caller can no longer open must stop appearing, and
 * DELETE must sit behind CSRF.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const authenticateMock = vi.fn();
const isAuthErrorMock = vi.fn();
const canUserViewPageMock = vi.fn();
/**
 * The ONE conversation-access predicate, stubbed at its module boundary — the
 * same seam `/api/ai/conversations/revs`' tests use, because
 * `canAccessConversation` reaches its permission dependency through a
 * package-relative import that a consumer's `vi.mock` cannot intercept.
 *
 * What this suite therefore proves is DELEGATION: that this route asks the
 * shared predicate, and asks it about the right row. What the predicate then
 * decides is `conversation-access.test.ts`' subject, and duplicating that here
 * would be two copies of one rule — exactly what the module exists to prevent.
 * The assertions below check the ROW passed, not just that a call happened.
 */
const canAccessConversationMock = vi.fn();
/**
 * The plan write goes through `conversationRepository.setConversationPlan`,
 * never an open-coded UPDATE — that repository method is what bumps `rev` and
 * emits `conversation:updated`, which is the only reason a second pane on the
 * same conversation ever drops its stale chip. Asserting on the raw
 * `db.update()` (as this file used to) would pass just as happily against a
 * write that converged nowhere.
 */
const setConversationPlan = vi.fn();

/**
 * One queue of rows per `db.select()` call, in the order the route makes them.
 *
 * GET does ownership → `resolveBoundPlan`'s joined lookup; DELETE does
 * ownership only. The join is why the chain carries `innerJoin`: the page half
 * of the read is the shared function now, not a second query written here.
 */
let selectResults: unknown[][] = [];

const makeChain = () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(selectResults.shift() ?? []),
  };
  return chain;
};

vi.mock('@pagespace/db/db', () => ({
  db: { select: () => makeChain() },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(() => ({})) }));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    setConversationPlan: (...a: unknown[]) => setConversationPlan(...a),
  },
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: {
    id: 'id',
    userId: 'userId',
    planPageId: 'planPageId',
    // The facts `canAccessConversation` decides on.
    isShared: 'isShared',
    type: 'type',
    contextId: 'contextId',
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', title: 'title', driveId: 'driveId', isTrashed: 'isTrashed' },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...a: unknown[]) => authenticateMock(...a),
  isAuthError: (...a: unknown[]) => isAuthErrorMock(...a),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: (...a: unknown[]) => canUserViewPageMock(...a),
}));
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({
  canAccessConversation: (...a: unknown[]) => canAccessConversationMock(...a),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { GET, DELETE } from '../route';

const OWNER = 'user-1';
const context = { params: Promise.resolve({ conversationId: 'conv-1' }) };
const request = () => new Request('https://example.test/api/ai/conversations/conv-1/plan');

const authAs = (userId: string) => {
  authenticateMock.mockResolvedValue({ userId } as unknown as SessionAuthResult);
  isAuthErrorMock.mockReturnValue(false);
};

const COLLABORATOR = 'user-2';
const AGENT_PAGE = 'pg_agent';

/**
 * GET's access probe — the columns `canAccessConversation` decides on.
 * Private by default; the shared cases opt in explicitly.
 */
const conversationRow = (over: Record<string, unknown> = {}) => ({
  userId: OWNER,
  isShared: false,
  type: 'page',
  contextId: AGENT_PAGE,
  ...over,
});
/** DELETE's probe is still ownership alone — see the route's docblock for why. */
const ownedConversation = () => ({ ownerId: OWNER });
/** What `resolveBoundPlan`'s conversation-to-page join returns. */
const livePlanRow = { pageId: 'pg_plan', title: 'Migrate billing', driveId: 'drv_1', isTrashed: false };

describe('GET /api/ai/conversations/[conversationId]/plan', () => {
  beforeEach(() => {
    authenticateMock.mockReset();
    isAuthErrorMock.mockReset();
    canUserViewPageMock.mockReset().mockResolvedValue(true);
    // Default: the caller may access the conversation. The refusal cases set
    // it false explicitly, so no test relies on a shared default to deny.
    canAccessConversationMock.mockReset().mockResolvedValue(true);
    setConversationPlan.mockReset().mockResolvedValue('set');
    selectResults = [];
  });

  it('propagates the auth error when unauthenticated', async () => {
    const error = { error: new Response(null, { status: 401 }) } as unknown as AuthError;
    authenticateMock.mockResolvedValue(error);
    isAuthErrorMock.mockReturnValue(true);

    const response = await GET(request(), context);
    expect(response.status).toBe(401);
  });

  it('returns the bound plan for its owner', async () => {
    authAs(OWNER);
    selectResults = [[conversationRow()], [livePlanRow]];

    const body = await (await GET(request(), context)).json();
    expect(body.plan).toEqual({ pageId: 'pg_plan', title: 'Migrate billing', driveId: 'drv_1' });
  });

  it('returns a null plan for an unbound conversation', async () => {
    authAs(OWNER);
    // The join finds nothing when `planPageId` is null — an inner join on it.
    selectResults = [[conversationRow()], []];

    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).plan).toBeNull();
  });

  it('404s another user\'s PRIVATE conversation rather than 403ing it', async () => {
    // A 403 would confirm the conversation exists. Isolation here has to be
    // indistinguishable from absence.
    authAs('someone-else');
    canAccessConversationMock.mockResolvedValue(false);
    selectResults = [[conversationRow()], [livePlanRow]];

    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    // Refused before the plan is even looked up — the queued plan row is still
    // unconsumed, so a 404 costs one query and discloses nothing about the
    // plan behind it.
    expect(selectResults).toHaveLength(1);
  });

  it('404s a conversation that does not exist', async () => {
    authAs(OWNER);
    selectResults = [[]];

    expect((await GET(request(), context)).status).toBe(404);
  });

  it('suppresses a trashed plan page', async () => {
    authAs(OWNER);
    selectResults = [[conversationRow()], [{ ...livePlanRow, isTrashed: true }]];

    expect((await (await GET(request(), context)).json()).plan).toBeNull();
  });

  it('suppresses a plan the caller can no longer view', async () => {
    // Access is re-checked at read time: permissions can be revoked after
    // set_plan ran, and a chip pointing at something unopenable is worse than
    // no chip.
    authAs(OWNER);
    selectResults = [[conversationRow()], [livePlanRow]];
    canUserViewPageMock.mockResolvedValue(false);

    expect((await (await GET(request(), context)).json()).plan).toBeNull();
  });

  it('500s without leaking internals when the lookup throws', async () => {
    authAs(OWNER);
    canUserViewPageMock.mockRejectedValue(new Error('boom'));
    selectResults = [[conversationRow()], [livePlanRow]];

    const response = await GET(request(), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to load plan' });
  });

  /**
   * THE GATE IS `canAccessConversation`, NOT OWNERSHIP (review finding).
   *
   * This route gated on `ownerId !== userId` while the realtime
   * `join_conversation` handler, `/stream-join`, `/active-streams` and
   * `/api/ai/conversations/revs` all route through the shared predicate. The
   * effect on a shared page conversation was that a collaborator could read
   * every message and join the room, but the plan chip 404'd — so the plan the
   * agent was visibly following was invisible to exactly the people the
   * conversation was shared with, and each of their views fired a failing
   * request for SWR to retry.
   *
   * Fails on the old code with a 404.
   */
  it('returns the plan to a collaborator on a SHARED page conversation', async () => {
    authAs(COLLABORATOR);
    selectResults = [[conversationRow({ isShared: true })], [livePlanRow]];

    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).plan).toEqual({
      pageId: 'pg_plan',
      title: 'Migrate billing',
      driveId: 'drv_1',
    });
    // Delegated to the shared predicate, and given the WHOLE row it decides on
    // — `isShared`, `type` and `contextId` as well as the owner. A route that
    // passed only the owner could not express "shared AND page access" at all,
    // which is how it came to answer differently from its four siblings.
    expect(canAccessConversationMock).toHaveBeenCalledWith(
      COLLABORATOR,
      expect.objectContaining({
        userId: OWNER,
        isShared: true,
        type: 'page',
        contextId: AGENT_PAGE,
      }),
    );
  });

  it('404s when the shared predicate refuses, without reading the plan', async () => {
    // "Shared" is not "public" — the predicate is owner OR (isShared AND page
    // access), and it says no here. Whatever its reason, this route's job is
    // to refuse identically to a missing conversation.
    authAs(COLLABORATOR);
    canAccessConversationMock.mockResolvedValue(false);
    selectResults = [[conversationRow({ isShared: true })], [livePlanRow]];

    expect((await GET(request(), context)).status).toBe(404);
    expect(selectResults).toHaveLength(1);
  });

  it('suppresses the plan PAGE for a collaborator who cannot open it, without 404ing the conversation', async () => {
    // Two independent checks, and they answer different questions: the
    // conversation is reachable (200) but the plan it points at is not
    // (`plan: null`). `resolveBoundPlan` re-checks against THIS caller, so
    // widening the conversation gate cannot widen what a collaborator sees.
    authAs(COLLABORATOR);
    canUserViewPageMock.mockResolvedValue(false);
    selectResults = [[conversationRow({ isShared: true })], [livePlanRow]];

    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).plan).toBeNull();
  });
});

describe('DELETE /api/ai/conversations/[conversationId]/plan', () => {
  beforeEach(() => {
    authenticateMock.mockReset();
    isAuthErrorMock.mockReset();
    canUserViewPageMock.mockReset().mockResolvedValue(true);
    setConversationPlan.mockReset().mockResolvedValue('set');
    selectResults = [];
  });

  it('requires CSRF', async () => {
    // The write path must not share the read path's requireCSRF: false.
    const { DELETE: handler } = await import('../route');
    expect(typeof handler).toBe('function');

    const error = { error: new Response(null, { status: 403 }) } as unknown as AuthError;
    authenticateMock.mockResolvedValue(error);
    isAuthErrorMock.mockReturnValue(true);

    expect((await DELETE(request(), context)).status).toBe(403);
    expect(authenticateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireCSRF: true }),
    );
  });

  it('unbinds the plan for its owner', async () => {
    authAs(OWNER);
    selectResults = [[ownedConversation()]];

    const response = await DELETE(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).plan).toBeNull();
    // Clears the binding only — the page itself is never touched — and does it
    // through the choke point, with the caller's id so the write can re-check
    // ownership in its own WHERE rather than trusting the read above.
    expect(setConversationPlan).toHaveBeenCalledTimes(1);
    expect(setConversationPlan).toHaveBeenCalledWith('conv-1', OWNER, null);
  });

  it('404s another user\'s conversation and writes nothing', async () => {
    authAs('someone-else');
    selectResults = [[ownedConversation()]];

    expect((await DELETE(request(), context)).status).toBe(404);
    expect(setConversationPlan).not.toHaveBeenCalled();
  });

  /**
   * The deliberate asymmetry with GET. `canAccessConversation` answers "may
   * this caller OBSERVE the conversation" — the question every subscription
   * surface asks, and now the question the plan READ asks. Unbinding is a
   * mutation of the conversation, and a collaborator on a shared thread has no
   * business clearing the plan its owner's agent is working from.
   */
  it('stays owner-only for a collaborator who CAN read the same shared conversation', async () => {
    authAs(COLLABORATOR);
    selectResults = [[ownedConversation()]];

    expect((await DELETE(request(), context)).status).toBe(404);
    expect(setConversationPlan).not.toHaveBeenCalled();
  });

  it('500s without leaking internals when the update throws', async () => {
    authAs(OWNER);
    selectResults = [[ownedConversation()]];
    setConversationPlan.mockRejectedValue(new Error('boom'));

    const response = await DELETE(request(), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to clear plan' });
  });
});
