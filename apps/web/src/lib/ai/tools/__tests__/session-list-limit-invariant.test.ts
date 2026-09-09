import { describe, it, expect } from 'vitest';
import { MAX_ACTIVE_SESSIONS_PER_OWNER } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { MAX_ACTIVE_WORKSPACES_PER_OWNER } from '@pagespace/lib/agent-workspaces/session-contract';

/**
 * `listOwnWorkspaces` (session-tools-runtime.ts) excludes the caller's
 * current workspace AFTER `listSessions` already applied the store's listing
 * cap, not before — sound only because no owner can ever HAVE more active
 * workspaces than one listing page shows.
 *
 * That used to be an equality between two constants in two packages
 * (`SESSION_LIST_LIMIT` vs `MAX_ACTIVE_SESSIONS_PER_OWNER`), kept in lockstep
 * by hand and by this test. It is now STRUCTURAL: both the spawn ceiling and
 * the store's `.limit()` read the one `MAX_ACTIVE_WORKSPACES_PER_OWNER` in
 * the contract module, and apps/web's `MAX_ACTIVE_SESSIONS_PER_OWNER` is a
 * re-export of it. This test pins that identity so nobody re-introduces an
 * independent second number under the old name — the drift it would catch is
 * exactly a redefinition, since a faithful re-export cannot differ.
 */
describe('MAX_ACTIVE_SESSIONS_PER_OWNER — the re-export identity listOwnWorkspaces\' post-cap exclusion relies on', () => {
  it('apps/web re-exports the one contract constant rather than defining a second number', () => {
    expect(MAX_ACTIVE_SESSIONS_PER_OWNER).toBe(MAX_ACTIVE_WORKSPACES_PER_OWNER);
  });
});
