import { describe, it, expect, vi } from 'vitest';
import { makeResolveShellPayer } from '../shell-payer';

type Subject = Parameters<ReturnType<typeof makeResolveShellPayer>>[0];
const session = (driveId: string | null) => ({ id: 'sess-1', driveId, ownerId: 'priya' }) as unknown as Subject;

describe('makeResolveShellPayer — who a terminal connect is charged to', () => {
  it('WAL-2 (partial) review #2760 P2-1: an org drive\'s terminal is charged to the org pool UNDER THE ACTOR connecting, never the session owner', async () => {
    const lookupDriveBillingFacts = vi.fn().mockResolvedValue({ ownerId: 'lead', orgId: 'org-1' });
    const resolve = makeResolveShellPayer({ lookupDriveBillingFacts });

    expect(await resolve(session('drive-1'), 'ben')).toEqual({ charge: { kind: 'org', orgId: 'org-1', userId: 'ben' }, driveId: 'drive-1' });
    expect(lookupDriveBillingFacts).toHaveBeenCalledWith('drive-1');
  });

  it('WAL-2 (partial) a personal drive\'s terminal is charged to the drive owner\'s own wallet, whoever connects', async () => {
    const resolve = makeResolveShellPayer({ lookupDriveBillingFacts: vi.fn().mockResolvedValue({ ownerId: 'lead', orgId: null }) });
    expect(await resolve(session('drive-1'), 'ben')).toEqual({ charge: { kind: 'user', userId: 'lead' }, driveId: 'drive-1' });
  });

  it('a global-assistant session (no drive) is the session owner\'s, and a vanished drive drops its id', async () => {
    const lookupDriveBillingFacts = vi.fn().mockResolvedValue(null);
    const resolve = makeResolveShellPayer({ lookupDriveBillingFacts });
    expect(await resolve(session(null), 'ben')).toEqual({ charge: { kind: 'user', userId: 'priya' }, driveId: null });
    expect(lookupDriveBillingFacts).not.toHaveBeenCalled();
    expect(await resolve(session('gone'), 'ben')).toEqual({ charge: { kind: 'user', userId: 'priya' }, driveId: null });
  });
});
