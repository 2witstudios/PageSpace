/**
 * The ONE conversation-subscription predicate (Agent-Session SSoT epic,
 * Phase 2): owner OR (isShared AND page access). Enforced at the realtime
 * `join_conversation` handler, /stream-join, and /active-streams — all
 * through this module, so these tests pin the rule for all three.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  canAccessConversation,
  decideConversationAccess,
} from '../conversation-access';

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
      canAccessConversation('owner-1', pageConversation(), { getPageAccess }),
    ).resolves.toBe(true);
    expect(getPageAccess).not.toHaveBeenCalled();
  });

  it('denies a non-owner on a PRIVATE conversation without page-access IO (fails closed, no oracle)', async () => {
    const getPageAccess = vi.fn();
    await expect(
      canAccessConversation('intruder', pageConversation({ isShared: false }), { getPageAccess }),
    ).resolves.toBe(false);
    expect(getPageAccess).not.toHaveBeenCalled();
  });

  it('allows a collaborator on a SHARED page conversation when they can access the page', async () => {
    const getPageAccess = vi.fn().mockResolvedValue(true);
    await expect(
      canAccessConversation('collab', pageConversation({ isShared: true }), { getPageAccess }),
    ).resolves.toBe(true);
    expect(getPageAccess).toHaveBeenCalledWith('collab', 'page-1');
  });

  it('denies a shared page conversation when the caller has no page access', async () => {
    const getPageAccess = vi.fn().mockResolvedValue(false);
    await expect(
      canAccessConversation('stranger', pageConversation({ isShared: true }), { getPageAccess }),
    ).resolves.toBe(false);
  });

  it('denies a non-owner on a shared GLOBAL conversation — there is no page to share through', async () => {
    const getPageAccess = vi.fn();
    await expect(
      canAccessConversation(
        'collab',
        { userId: 'owner-1', isShared: true, type: 'global', contextId: null },
        { getPageAccess },
      ),
    ).resolves.toBe(false);
    expect(getPageAccess).not.toHaveBeenCalled();
  });

  it('denies a shared page conversation with a null contextId (nothing to authorize against)', async () => {
    await expect(
      canAccessConversation('collab', pageConversation({ isShared: true, contextId: null })),
    ).resolves.toBe(false);
  });
});
