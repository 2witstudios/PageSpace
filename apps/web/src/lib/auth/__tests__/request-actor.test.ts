import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  explainSignInRefusal: vi.fn(),
}));

import { explainSignInRefusal } from '@pagespace/lib/permissions/permissions';
import { actorFromAuth, actorFromVerifiedUser, deniedResponse, orgSignInRequiredResponse } from '../request-actor';

const evidence = { authenticatedAtMs: 1_700_000_000_000, assurance: 'single_factor' as const };

describe('request actor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('actorFromAuth carries the credential\'s user and ceremony evidence', () => {
    expect(actorFromAuth({ userId: 'user-1', authentication: evidence }))
      .toEqual({ via: 'credential', userId: 'user-1', authentication: evidence });
  });

  it('a credential without evidence becomes an actor with null evidence, never fabricated', () => {
    expect(actorFromAuth({ userId: 'user-1', authentication: undefined })).toEqual({ via: 'credential', userId: 'user-1', authentication: null });
    expect(actorFromVerifiedUser({ id: 'user-2', authentication: null }))
      .toEqual({ via: 'credential', userId: 'user-2', authentication: null });
  });
});

describe('SEC-2 (partial) SEC-3 (partial) a sign-in policy refusal reaches the response as 403 with its code', () => {
  const actor = actorFromAuth({ userId: 'user-1', authentication: evidence });
  const fallback = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  it.each(['org_strong_sign_in_required', 'org_reauthentication_required'] as const)('answers 403 { error, code: %s } when the org\'s sign-in policy refused', async (code) => {
    vi.mocked(explainSignInRefusal).mockResolvedValue(code);
    const response = await deniedResponse(actor, 'page-1', fallback());
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe(code);
    expect(typeof body.error).toBe('string');
    expect(explainSignInRefusal).toHaveBeenCalledWith(actor, 'page-1');
  });

  it('keeps the route\'s own refusal when sign-in policy is not why', async () => {
    vi.mocked(explainSignInRefusal).mockResolvedValue(null);
    const original = NextResponse.json({ error: 'Not found' }, { status: 404 });
    const response = await deniedResponse(actor, 'page-1', original);
    expect(response).toBe(original);
  });

  it("a refusal with no page or drive to name keeps the route's own response and asks nothing", async () => {
    vi.mocked(explainSignInRefusal).mockClear();
    const original = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    expect(await deniedResponse(actor, null, original)).toBe(original);
    expect(explainSignInRefusal).not.toHaveBeenCalled();
  });

  it('orgSignInRequiredResponse is the one shape every route answers', async () => {
    const response = orgSignInRequiredResponse('org_reauthentication_required');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.any(String), code: 'org_reauthentication_required' });
  });
});
