import { describe, it, expect, vi, beforeEach } from 'vitest';

const getHomeDriveMock = vi.fn();
vi.mock('@pagespace/lib/services/drive-service', () => ({
  getHomeDrive: (...args: unknown[]) => getHomeDriveMock(...args),
}));

import { resolveHomeDriveHint } from '../home-drive-hint';

const HOME = { id: 'drv_home' };

describe('resolveHomeDriveHint', () => {
  beforeEach(() => {
    getHomeDriveMock.mockReset().mockResolvedValue(HOME);
  });

  it('returns the Home drive id when the caller is standing nowhere', async () => {
    expect(await resolveHomeDriveHint('user-1', false)).toBe('drv_home');
  });

  it('skips the lookup entirely when a location is already in view', async () => {
    // The hint only renders in the no-location branch, so the common
    // in-a-drive path must not pay a query.
    expect(await resolveHomeDriveHint('user-1', true)).toBeUndefined();
    expect(getHomeDriveMock).not.toHaveBeenCalled();
  });

  it('returns undefined when the user has no Home drive', async () => {
    getHomeDriveMock.mockResolvedValue(null);
    expect(await resolveHomeDriveHint('user-1', false)).toBeUndefined();
  });

  it('treats an empty scope as unscoped (session auth)', async () => {
    expect(await resolveHomeDriveHint('user-1', false, [])).toBe('drv_home');
  });

  it('returns the id when the scope includes the Home drive', async () => {
    expect(await resolveHomeDriveHint('user-1', false, ['drv_other', 'drv_home'])).toBe('drv_home');
  });

  it('withholds the id from a token scoped away from Home', async () => {
    // Two harms without this. The id is disclosed to a principal that may not
    // reach that drive; and because the /plan body sends driveless plans to
    // Home, the agent would be steered into a create_page that
    // driveOutsideMcpScope rejects every time.
    expect(await resolveHomeDriveHint('user-1', false, ['drv_other'])).toBeUndefined();
  });

  it('degrades to undefined rather than throwing when the lookup fails', async () => {
    // A convenience hint must never fail a chat request.
    getHomeDriveMock.mockRejectedValue(new Error('db down'));
    await expect(resolveHomeDriveHint('user-1', false)).resolves.toBeUndefined();
  });

  it('degrades to undefined on a synchronous throw', async () => {
    // try/catch rather than .catch() precisely so this case is covered.
    getHomeDriveMock.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(resolveHomeDriveHint('user-1', false)).resolves.toBeUndefined();
  });
});
