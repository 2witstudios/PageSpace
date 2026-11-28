/**
 * ORG-1 × ADR 0008: agent accounts are users rows (accountType = 'agent'), so
 * loadOrgPrincipalKind must answer 'agent' for them — an agent never becomes
 * an org Owner (createOrganization, transferOwnership) and so never ends up the
 * billing contact of an org's Stripe customer.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ and: vi.fn(), eq: vi.fn(), inArray: vi.fn(), isNotNull: vi.fn(), or: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', accountType: 'accountType' } }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id', type: 'type' } }));
vi.mock('@pagespace/db/schema/data-subject-requests', () => ({ dataSubjectRequests: {} }));

import { decideOrgOwnerCandidate, loadOrgPrincipalKind } from '../owner-candidate';

type Row = Record<string, unknown>;

/** A select chain answering the users lookup first, then the pages lookup. */
function fakeExecutor(userRows: Row[], pageRows: Row[]): Parameters<typeof loadOrgPrincipalKind>[0] {
  const answers = [userRows, pageRows];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => answers.shift() ?? [],
  };
  return { select: () => chain } as unknown as Parameters<typeof loadOrgPrincipalKind>[0];
}

describe('loadOrgPrincipalKind', () => {
  it('given a human users row, should answer human', async () => {
    expect(await loadOrgPrincipalKind(fakeExecutor([{ id: 'u1', accountType: 'human' }], []), 'u1')).toBe('human');
  });

  it('given an agent account users row, should answer agent so it can never own an org', async () => {
    const kind = await loadOrgPrincipalKind(fakeExecutor([{ id: 'a1', accountType: 'agent' }], []), 'a1');
    expect(kind).toBe('agent');
    expect(decideOrgOwnerCandidate(kind)).toEqual({ ok: false, status: 400, reason: 'owner_not_human' });
  });

  it('given an AI_CHAT page id, should answer agent', async () => {
    expect(await loadOrgPrincipalKind(fakeExecutor([], [{ id: 'p1' }]), 'p1')).toBe('agent');
  });

  it('given nothing, should answer null', async () => {
    expect(await loadOrgPrincipalKind(fakeExecutor([], []), 'x')).toBeNull();
  });
});
