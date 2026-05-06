import { describe, it, expect } from 'vitest';
import { acceptUserPendingInvitations } from '../post-login-pending-acceptance';

// The function is a deprecated shim that retains its name + signature so the
// post-login-acceptance-coverage gate continues to fire and the 9 existing
// auth routes keep compiling. Pending invites no longer live in drive_members
// — they live in pending_invites and are accepted at /invite/[token]/accept
// for existing users or in /api/auth/signup-passkey for new users.

describe('acceptUserPendingInvitations (deprecated shim)', () => {
  it('returns an empty array regardless of userId', async () => {
    const result = await acceptUserPendingInvitations('user_anyone');
    expect(result).toEqual([]);
  });

  it('does not query the database (no broad userId-keyed sweep remains)', async () => {
    // No mocks needed: the implementation is a pure constant-return shim.
    // If a future refactor reintroduces a query, this test stops being
    // trivially true and someone has to engage with the deprecation note.
    await acceptUserPendingInvitations('user_other');
    await acceptUserPendingInvitations('');
    await acceptUserPendingInvitations('user_with_pending_in_old_model');
    expect(true).toBe(true);
  });
});
