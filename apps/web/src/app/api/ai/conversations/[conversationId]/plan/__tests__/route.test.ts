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
  conversations: { id: 'id', userId: 'userId', planPageId: 'planPageId' },
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

/** The ownership probe's row — `planPageId` now lives in the joined read below. */
const ownedConversation = () => ({ ownerId: OWNER });
/** What `resolveBoundPlan`'s conversation-to-page join returns. */
const livePlanRow = { pageId: 'pg_plan', title: 'Migrate billing', driveId: 'drv_1', isTrashed: false };

describe('GET /api/ai/conversations/[conversationId]/plan', () => {
  beforeEach(() => {
    authenticateMock.mockReset();
    isAuthErrorMock.mockReset();
    canUserViewPageMock.mockReset().mockResolvedValue(true);
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
    selectResults = [[ownedConversation()], [livePlanRow]];

    const body = await (await GET(request(), context)).json();
    expect(body.plan).toEqual({ pageId: 'pg_plan', title: 'Migrate billing', driveId: 'drv_1' });
  });

  it('returns a null plan for an unbound conversation', async () => {
    authAs(OWNER);
    // The join finds nothing when `planPageId` is null — an inner join on it.
    selectResults = [[ownedConversation()], []];

    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).plan).toBeNull();
  });

  it('404s another user\'s conversation rather than 403ing it', async () => {
    // A 403 would confirm the conversation exists. Ownership isolation here has
    // to be indistinguishable from absence.
    authAs('someone-else');
    selectResults = [[ownedConversation()]];

    const response = await GET(request(), context);
    expect(response.status).toBe(404);
  });

  it('404s a conversation that does not exist', async () => {
    authAs(OWNER);
    selectResults = [[]];

    expect((await GET(request(), context)).status).toBe(404);
  });

  it('suppresses a trashed plan page', async () => {
    authAs(OWNER);
    selectResults = [[ownedConversation()], [{ ...livePlanRow, isTrashed: true }]];

    expect((await (await GET(request(), context)).json()).plan).toBeNull();
  });

  it('suppresses a plan the caller can no longer view', async () => {
    // Access is re-checked at read time: permissions can be revoked after
    // set_plan ran, and a chip pointing at something unopenable is worse than
    // no chip.
    authAs(OWNER);
    selectResults = [[ownedConversation()], [livePlanRow]];
    canUserViewPageMock.mockResolvedValue(false);

    expect((await (await GET(request(), context)).json()).plan).toBeNull();
  });

  it('500s without leaking internals when the lookup throws', async () => {
    authAs(OWNER);
    canUserViewPageMock.mockRejectedValue(new Error('boom'));
    selectResults = [[ownedConversation()], [livePlanRow]];

    const response = await GET(request(), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to load plan' });
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

  it('500s without leaking internals when the update throws', async () => {
    authAs(OWNER);
    selectResults = [[ownedConversation()]];
    setConversationPlan.mockRejectedValue(new Error('boom'));

    const response = await DELETE(request(), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to clear plan' });
  });
});
