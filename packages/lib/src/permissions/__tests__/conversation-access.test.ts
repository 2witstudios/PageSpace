/**
 * The ONE conversation-subscription predicate (Agent-Session SSoT epic,
 * Phase 2): owner OR (isShared AND page access). Enforced at the realtime
 * `join_conversation` handler, /stream-join, and /active-streams — all
 * through this module, so these tests pin the rule for all three.
 */
import { describe, it, expect, vi } from 'vitest';
// The org sign-in gate (D-OW-45) reads policies through its own module; these tests are about the
// resolvers behind it, so no org here sets a sign-in policy. Plain functions: a mock reset must not undo them.
vi.mock('../actor-authentication', () => ({
  checkActorDriveAuthentication: async () => ({ allowed: true }),
  checkActorResourceAuthentication: async () => ({ allowed: true }),
  filterDrivesForActor: async (_actor: unknown, ids: readonly string[]) => new Set(ids),
  filterResourcesForActor: async (_actor: unknown, ids: readonly string[]) => new Set(ids),
  explainOrgAuthenticationDenial: async () => null,
}));

import {
  canAccessConversation,
  decideConversationAccess,
} from '../conversation-access';
import { credentialActor } from '../access-actor';

const pageConversation = (overrides: Partial<{ userId: string; isShared: boolean; type: string; contextId: string | null }> = {}) => ({
  userId: 'owner-1',
  isShared: false,
  type: 'page',
  contextId: 'page-1',
  ...overrides,
});

describe('decideConversationAccess (pure core)', () => {
  it('owner always passes, regardless of sharing or page access', () => {
    expect(decideConversationAccess({ isOwner: true, isShared: false, hasPageAccess: false })).toBe(true);
  });

  it('non-owner needs BOTH isShared and page access', () => {
    expect(decideConversationAccess({ isOwner: false, isShared: true, hasPageAccess: true })).toBe(true);
    expect(decideConversationAccess({ isOwner: false, isShared: true, hasPageAccess: false })).toBe(false);
    expect(decideConversationAccess({ isOwner: false, isShared: false, hasPageAccess: true })).toBe(false);
    expect(decideConversationAccess({ isOwner: false, isShared: false, hasPageAccess: false })).toBe(false);
  });
});

describe('canAccessConversation', () => {
  it('allows the owner with no page-access IO at all', async () => {
    const getPageAccess = vi.fn();
    await expect(
      canAccessConversation(credentialActor('owner-1', null), pageConversation(), { getPageAccess }),
    ).resolves.toBe(true);
    expect(getPageAccess).not.toHaveBeenCalled();
  });

  it('denies a non-owner on a PRIVATE conversation without page-access IO (fails closed, no oracle)', async () => {
    const getPageAccess = vi.fn();
    await expect(
      canAccessConversation(credentialActor('intruder', null), pageConversation({ isShared: false }), { getPageAccess }),
    ).resolves.toBe(false);
    expect(getPageAccess).not.toHaveBeenCalled();
  });

  it('allows a collaborator on a SHARED page conversation when they can access the page', async () => {
    const getPageAccess = vi.fn().mockResolvedValue(true);
    await expect(
      canAccessConversation(credentialActor('collab', null), pageConversation({ isShared: true }), { getPageAccess }),
    ).resolves.toBe(true);
    expect(getPageAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: 'collab' }), 'page-1');
  });

  it('denies a shared page conversation when the caller has no page access', async () => {
    const getPageAccess = vi.fn().mockResolvedValue(false);
    await expect(
      canAccessConversation(credentialActor('stranger', null), pageConversation({ isShared: true }), { getPageAccess }),
    ).resolves.toBe(false);
  });

  it('denies a non-owner on a shared GLOBAL conversation — there is no page to share through', async () => {
    const getPageAccess = vi.fn();
    await expect(
      canAccessConversation(
        credentialActor('collab', null),
        { userId: 'owner-1', isShared: true, type: 'global', contextId: null },
        { getPageAccess },
      ),
    ).resolves.toBe(false);
    expect(getPageAccess).not.toHaveBeenCalled();
  });

  it('denies a shared page conversation with a null contextId (nothing to authorize against)', async () => {
    await expect(
      canAccessConversation(credentialActor('collab', null), pageConversation({ isShared: true, contextId: null })),
    ).resolves.toBe(false);
  });
});

describe('/btw surface conversations (owner-scoped)', () => {
  it('allows the owner of a GLOBAL conversation — dashboard/sidebar global mode', async () => {
    await expect(
      canAccessConversation(credentialActor('owner-1', null), { userId: 'owner-1', isShared: false, type: 'global', contextId: null })
    ).resolves.toBe(true);
  });

  it('allows the owner of an agent (page) conversation — agent mode on both surfaces', async () => {
    await expect(
      canAccessConversation(credentialActor('owner-1', null), { userId: 'owner-1', isShared: false, type: 'page', contextId: 'agent-1' })
    ).resolves.toBe(true);
  });
});
