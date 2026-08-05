import { describe, it, expect } from 'vitest';
import { MAX_ACTIVE_SESSIONS_PER_OWNER } from '@/lib/agent-sessions/agent-sessions-runtime';
import { SESSION_LIST_LIMIT } from '@pagespace/lib/services/agent-sessions/agent-sessions-store';

/**
 * `listOwnWorkspaces` (session-tools-runtime.ts) excludes the caller's
 * current workspace AFTER `listSessions` already applied SESSION_LIST_LIMIT,
 * not before — sound only because no owner can ever HAVE more sessions than
 * this limit shows, so the cap never actually truncates and the exclusion
 * never drops a workspace a pre-cap exclusion would have backfilled (review
 * finding — CodeRabbit). That soundness rests entirely on this inequality;
 * if it ever fails, `listOwnWorkspaces`' post-cap filter needs revisiting
 * (push the exclusion into a new `AgentSessionListFilter` shape instead).
 */
describe('SESSION_LIST_LIMIT vs MAX_ACTIVE_SESSIONS_PER_OWNER — the invariant listOwnWorkspaces\' post-cap exclusion relies on', () => {
  it('an owner can never accumulate more active sessions than one listing page shows', () => {
    expect(MAX_ACTIVE_SESSIONS_PER_OWNER).toBeLessThanOrEqual(SESSION_LIST_LIMIT);
  });
});
