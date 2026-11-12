/**
 * The scoped, avatar and site-parking takedowns, and the request-level rules
 * (reuse, resume, refusals). The global sequence is proven end to end in
 * takedown.integration.test.ts and step by step in the lib's takedown tests;
 * here the case store is in memory and each effect is a spy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContentCase, ContentCaseSnapshot, ContentCaseStep } from '@pagespace/db/schema/content-safety';

const cases = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const mocks = vi.hoisted(() => ({
  unpublishPage: vi.fn(),
  parkDriveSites: vi.fn(),
  parkUserSites: vi.fn(),
  releaseDriveHold: vi.fn(),
  restoreUserSites: vi.fn(),
  createToken: vi.fn(),
  sendAlert: vi.fn(),
  clearImage: vi.fn(),
  listAvatars: vi.fn(),
  openCreated: { value: true },
  openThrows: { value: null as Error | null },
  /** Case IDs another run holds the lock on. */
  locked: new Set<string>(),
}));

const CaseCategoryDowngradeError = vi.hoisted(() => class CaseCategoryDowngradeError extends Error {});
vi.mock('@pagespace/lib/content-safety/case-store', () => ({
  CaseCategoryDowngradeError,
  createTakedownCaseStore: () => ({
    load: async (id: string) => (cases.has(id) ? structuredClone(cases.get(id)) : null),
    appendStep: async (id: string, step: ContentCaseStep) => {
      const row = cases.get(id)!;
      row.steps = [...((row.steps as ContentCaseStep[]) ?? []), step];
    },
    setStatus: async (id: string, status: string) => {
      cases.get(id)!.status = status;
    },
    mergeSnapshot: async (id: string, patch: Partial<ContentCaseSnapshot>) => {
      const row = cases.get(id)!;
      row.snapshot = { ...(row.snapshot as object), ...patch };
    },
    upsertBlock: vi.fn(),
    collectReferences: vi.fn(),
    withCaseLock: async <T,>(id: string, fn: () => Promise<T>) =>
      mocks.locked.has(id) ? { acquired: false as const } : { acquired: true as const, value: await fn() },
  }),
  getContentCase: async (id: string) => (cases.has(id) ? structuredClone(cases.get(id)) : null),
  openTakedownCase: async (input: { targetType: string; targetId: string; category: string; reason: string; takedown: { kind: string }; snapshot?: object }) => {
    if (mocks.openThrows.value) throw mocks.openThrows.value;
    const id = `case-${input.takedown.kind}-${input.targetId}`;
    const created = mocks.openCreated.value && !cases.has(id);
    if (!cases.has(id)) {
      cases.set(id, {
        id,
        targetType: input.targetType,
        targetId: input.targetId,
        contentHash: null,
        status: 'open',
        category: input.category,
        reason: input.reason,
        snapshot: { ...input.snapshot, takedown: input.takedown },
        steps: [],
      });
    }
    return { case: structuredClone(cases.get(id)), created };
  },
}));

vi.mock('@pagespace/lib/content-safety/alerts', () => ({ sendContentSafetyAlert: mocks.sendAlert }));
vi.mock('@pagespace/lib/organizations/published-visibility', () => {
  class UserStillSuspendedError extends Error {}
  return {
    UserStillSuspendedError,
    parkDriveSites: mocks.parkDriveSites,
    parkUserSites: mocks.parkUserSites,
    releaseDriveHold: mocks.releaseDriveHold,
    restoreUserSites: mocks.restoreUserSites,
  };
});
vi.mock('@pagespace/lib/services/validated-service-token', () => ({ createSystemAvatarDeleteToken: mocks.createToken }));
vi.mock('@pagespace/lib/auth/suspend-user', () => ({ suspendUser: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@/lib/canvas/unpublish-page', () => ({ unpublishPage: mocks.unpublishPage }));
vi.mock('@/lib/canvas/published-storage', () => ({
  createPublishedObjectStore: () => ({ real: true }),
  isPublishConfigured: () => true,
}));
vi.mock('../takedown-storage', () => ({ createTakedownStorage: () => ({ evidenceConfigured: () => true }) }));
vi.mock('@/lib/presigned-url', () => ({
  getS3Bucket: () => 'uploads',
  getS3Client: () => ({ send: (command: { input: { Prefix?: string } }) => mocks.listAvatars(command.input) }),
}));
vi.mock('@pagespace/db/db', () => ({
  db: {
    update: () => ({ set: () => ({ where: () => ({ returning: () => mocks.clearImage() }) }) }),
  },
}));

import { TakedownRequestError, executeTakedown } from '../takedown-service';

const stepsOf = (id: string) => ((cases.get(id)?.steps as ContentCaseStep[]) ?? []).map((s) => `${s.step}:${s.status}`);
const fetchMock = vi.fn();

beforeEach(() => {
  cases.clear();
  vi.clearAllMocks();
  mocks.openCreated.value = true;
  mocks.openThrows.value = null;
  mocks.locked.clear();
  mocks.unpublishPage.mockResolvedValue({ unpublished: true, driveId: 'drive-1', path: 'docs' });
  mocks.parkDriveSites.mockResolvedValue({ driveId: 'drive-1', prefixes: [{ prefix: 'acme', action: 'parked', objects: 3 }] });
  mocks.parkUserSites.mockResolvedValue({
    parked: [{ driveId: 'drive-1', prefixes: [] }],
    skipped: [{ driveId: 'drive-2', reason: 'org_drive_with_other_members' }],
  });
  mocks.releaseDriveHold.mockResolvedValue({ driveId: 'drive-1', prefixes: [], released: true, remainingHolds: 0 });
  mocks.restoreUserSites.mockResolvedValue([{ driveId: 'drive-1', prefixes: [], released: true, remainingHolds: 0 }]);
  mocks.createToken.mockResolvedValue({ token: 'ps_svc_token', grantedScopes: [] });
  mocks.clearImage.mockResolvedValue([{ id: 'user-1' }]);
  mocks.listAvatars.mockResolvedValue({ Contents: [] });
  mocks.sendAlert.mockResolvedValue(undefined);
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('scoped takedown: unpublish a page', () => {
  const request = { action: 'unpublish_page', pageId: 'page-1', category: 'policy', reason: 'DMCA notice 42' } as const;

  it('unpublishes through the shared function and finishes the case, with no hash blocked', async () => {
    const result = await executeTakedown(request, 'admin-1');

    expect(mocks.unpublishPage).toHaveBeenCalledWith('page-1');
    expect(result).toMatchObject({ action: 'unpublish_page', status: 'actioned' });
    const row = cases.get(result.caseId!) as unknown as ContentCase;
    expect(row).toMatchObject({ targetType: 'page', targetId: 'page-1', category: 'policy', status: 'actioned' });
    expect(row.snapshot).toMatchObject({ takedown: { kind: 'unpublish_page', actorUserId: 'admin-1' }, driveIds: ['drive-1'] });
    expect(stepsOf(result.caseId!)).toEqual(['unpublish:ok']);
  });

  it('records a page that was not published as done, not as a failure', async () => {
    mocks.unpublishPage.mockResolvedValue({ unpublished: false });
    const result = await executeTakedown(request, 'admin-1');
    expect(result.status).toBe('actioned');
  });

  it('leaves the case open and resumable when storage fails, then finishes on resume', async () => {
    mocks.unpublishPage.mockRejectedValueOnce(new Error('S3 unavailable'));

    const first = await executeTakedown(request, 'admin-1');
    expect(first).toMatchObject({ status: 'open', failedStep: 'unpublish', error: 'S3 unavailable' });

    const resumed = await executeTakedown({ action: 'resume', caseId: first.caseId! }, 'admin-1');
    expect(resumed.status).toBe('actioned');
    expect(stepsOf(first.caseId!)).toEqual(['unpublish:failed', 'unpublish:ok']);
  });

  it('alerts once when the case opens and once when it is actioned', async () => {
    await executeTakedown(request, 'admin-1');
    expect(mocks.sendAlert.mock.calls.map(([alert]) => alert.event)).toEqual(['opened', 'actioned']);
  });

  it('does not alert "opened" again when an unfinished case is reused', async () => {
    mocks.openCreated.value = false;
    await executeTakedown(request, 'admin-1');
    expect(mocks.sendAlert.mock.calls.map(([alert]) => alert.event)).toEqual(['actioned']);
  });

  it('still finishes when the alert cannot be sent', async () => {
    mocks.sendAlert.mockRejectedValue(new Error('resend down'));
    expect((await executeTakedown(request, 'admin-1')).status).toBe('actioned');
  });
});

describe('scoped takedown: park a drive', () => {
  it('parks every site of the drive under a takedown hold tied to the case', async () => {
    const result = await executeTakedown({ action: 'park_drive', driveId: 'drive-1', category: 'policy', reason: 'terms' }, 'admin-1');

    expect(result.status).toBe('actioned');
    expect(mocks.parkDriveSites).toHaveBeenCalledWith(
      { driveId: 'drive-1', holder: { caseId: result.caseId }, createdBy: 'admin-1' },
      { real: true },
    );
    expect(cases.get(result.caseId!)).toMatchObject({ targetType: 'drive', targetId: 'drive-1' });
  });

  it('stays open when a prefix could not be moved', async () => {
    mocks.parkDriveSites.mockRejectedValue(new Error('Could not park acme: store unavailable'));
    const result = await executeTakedown({ action: 'park_drive', driveId: 'drive-1', category: 'policy', reason: 'terms' }, 'admin-1');
    expect(result).toMatchObject({ status: 'open', failedStep: 'park_sites' });
  });

  describe('restoring', () => {
    const park = () => executeTakedown({ action: 'park_drive', driveId: 'drive-1', category: 'policy', reason: 'terms' }, 'admin-1');

    it('lifts the hold this case placed, and records the restore on the case', async () => {
      const { caseId } = await park();
      const result = await executeTakedown({ action: 'restore_drive', caseId: caseId!, reason: 'counter-notice accepted' }, 'admin-2');

      expect(mocks.releaseDriveHold).toHaveBeenCalledWith({ driveId: 'drive-1', holder: { caseId } }, { real: true });
      expect(result).toMatchObject({ action: 'restore_drive', caseId, restoredDriveIds: ['drive-1'] });
      expect(stepsOf(caseId!)).toEqual(['park_sites:ok', 'restore_sites:ok']);
      expect((cases.get(caseId!) as unknown as ContentCase).snapshot).toMatchObject({
        restore: { actorUserId: 'admin-2', reason: 'counter-notice accepted' },
      });
    });

    it('says the drive is still parked when another hold remains', async () => {
      const { caseId } = await park();
      mocks.releaseDriveHold.mockResolvedValue({ driveId: 'drive-1', prefixes: [], released: true, remainingHolds: 1 });

      const result = await executeTakedown({ action: 'restore_drive', caseId: caseId!, reason: 'r' }, 'admin-1');

      expect(result).toMatchObject({ restoredDriveIds: [], stillHeldDriveIds: ['drive-1'] });
    });

    it('refuses when the case no longer holds the drive, recording nothing', async () => {
      const { caseId } = await park();
      mocks.releaseDriveHold.mockResolvedValue({ driveId: 'drive-1', prefixes: [], released: false, remainingHolds: 1 });

      await expect(executeTakedown({ action: 'restore_drive', caseId: caseId!, reason: 'r' }, 'admin-1')).rejects.toMatchObject({ status: 409 });
      expect(stepsOf(caseId!)).toEqual(['park_sites:ok']);
    });

    it('refuses a case that is not a drive-parking case', async () => {
      cases.set('c9', { id: 'c9', status: 'actioned', targetId: 'user-1', snapshot: { takedown: { kind: 'avatar' } }, steps: [] });
      await expect(executeTakedown({ action: 'restore_drive', caseId: 'c9', reason: 'r' }, 'admin-1')).rejects.toMatchObject({ status: 409 });
      expect(mocks.releaseDriveHold).not.toHaveBeenCalled();
    });
  });
});

describe('avatar takedown', () => {
  const request = { action: 'avatar', userId: 'user-1', category: 'csam', reason: 'reported avatar' } as const;

  it('deletes through the processor\'s service-auth route, clears the profile image, and records both on the case', async () => {
    const result = await executeTakedown(request, 'admin-1');

    expect(mocks.createToken).toHaveBeenCalledWith({ userId: 'user-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/avatar\/user-1$/);
    expect(init).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer ps_svc_token' } });
    expect(mocks.listAvatars).toHaveBeenCalledWith(expect.objectContaining({ Prefix: 'avatars/user-1/' }));
    expect(result.status).toBe('actioned');
    expect(stepsOf(result.caseId!)).toEqual(['delete_avatar:ok', 'clear_profile_image:ok']);
    expect(cases.get(result.caseId!)).toMatchObject({ targetType: 'avatar', targetId: 'user-1' });
  });

  it('keeps the profile image and the case open when the processor refuses, so a resume retries the delete', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));

    const first = await executeTakedown(request, 'admin-1');
    expect(first).toMatchObject({ status: 'open', failedStep: 'delete_avatar' });
    expect(mocks.clearImage).not.toHaveBeenCalled();

    const resumed = await executeTakedown({ action: 'resume', caseId: first.caseId! }, 'admin-1');
    expect(resumed.status).toBe('actioned');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.clearImage).toHaveBeenCalledTimes(1);
  });
});

describe('avatar takedown verification', () => {
  it('does not call the case done while avatar objects are still in storage', async () => {
    mocks.listAvatars.mockResolvedValue({ Contents: [{ Key: 'avatars/user-1/avatar.png' }] });

    const result = await executeTakedown({ action: 'avatar', userId: 'user-1', category: 'csam', reason: 'r' }, 'admin-1');

    expect(result).toMatchObject({ status: 'open', failedStep: 'delete_avatar' });
    expect(mocks.clearImage).not.toHaveBeenCalled();
  });
});

describe('suspension parks the user\'s sites', () => {
  it('parks owned drives and reports the ones left for an admin to decide', async () => {
    const result = await executeTakedown({ action: 'park_user_sites', userId: 'user-1', reason: 'suspended for abuse' }, 'admin-1');

    expect(mocks.parkUserSites).toHaveBeenCalledWith({ userId: 'user-1', createdBy: 'admin-1' }, { real: true });
    expect(result).toMatchObject({
      status: 'actioned',
      parkedDriveIds: ['drive-1'],
      skippedDrives: [{ driveId: 'drive-2', reason: 'org_drive_with_other_members' }],
    });
    expect((cases.get(result.caseId!) as unknown as ContentCase).snapshot).toMatchObject({
      driveIds: ['drive-1'],
      skippedDrives: [{ driveId: 'drive-2', reason: 'org_drive_with_other_members' }],
    });
  });

  it('restores them when the suspension is lifted, reporting drives another hold still keeps parked', async () => {
    mocks.restoreUserSites.mockResolvedValue([
      { driveId: 'drive-1', prefixes: [], released: true, remainingHolds: 0 },
      { driveId: 'drive-2', prefixes: [], released: true, remainingHolds: 1 },
    ]);
    const result = await executeTakedown({ action: 'restore_user_sites', userId: 'user-1' }, 'admin-1');

    expect(mocks.restoreUserSites).toHaveBeenCalledWith('user-1', { real: true });
    expect(result).toEqual({ action: 'restore_user_sites', restoredDriveIds: ['drive-1'], stillHeldDriveIds: ['drive-2'] });
  });

  it('refuses to restore while the user is still suspended', async () => {
    const { UserStillSuspendedError } = await import('@pagespace/lib/organizations/published-visibility');
    mocks.restoreUserSites.mockRejectedValue(new UserStillSuspendedError('user-1'));

    await expect(executeTakedown({ action: 'restore_user_sites', userId: 'user-1' }, 'admin-1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('requests that cannot be acted on', () => {
  it('answers 409 when an open CSAM case would be re-filed under another category', async () => {
    mocks.openThrows.value = new CaseCategoryDowngradeError('This content has an open CSAM case; it cannot be re-filed under another category.');

    await expect(
      executeTakedown({ action: 'unpublish_page', pageId: 'page-1', category: 'policy', reason: 'r' }, 'admin-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.unpublishPage).not.toHaveBeenCalled();
  });

  it('answers "in progress", changing nothing, when another run of the case is under way', async () => {
    mocks.unpublishPage.mockRejectedValueOnce(new Error('S3 unavailable'));
    const first = await executeTakedown({ action: 'unpublish_page', pageId: 'page-1', category: 'policy', reason: 'DMCA' }, 'admin-1');
    mocks.locked.add(first.caseId!);

    const resumed = await executeTakedown({ action: 'resume', caseId: first.caseId! }, 'admin-1');

    expect(resumed).toEqual({ action: 'resume', caseId: first.caseId, status: 'open', inProgress: true });
    expect(mocks.unpublishPage).toHaveBeenCalledTimes(1);
    expect(stepsOf(first.caseId!)).toEqual(['unpublish:failed']);
  });

  it('answers 404 for a case that does not exist', async () => {
    await expect(executeTakedown({ action: 'resume', caseId: 'missing' }, 'admin-1')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to resume a dismissed case', async () => {
    cases.set('c1', { id: 'c1', status: 'dismissed', snapshot: { takedown: { kind: 'avatar' } }, steps: [] });
    await expect(executeTakedown({ action: 'resume', caseId: 'c1' }, 'admin-1')).rejects.toBeInstanceOf(TakedownRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to resume a case that has no takedown (a plain report)', async () => {
    cases.set('c2', { id: 'c2', status: 'open', snapshot: {}, steps: [] });
    await expect(executeTakedown({ action: 'resume', caseId: 'c2' }, 'admin-1')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to re-sweep anything but a global takedown', async () => {
    cases.set('c3', { id: 'c3', status: 'actioned', snapshot: { takedown: { kind: 'avatar' } }, steps: [] });
    await expect(executeTakedown({ action: 'resweep', caseId: 'c3' }, null)).rejects.toMatchObject({ status: 409 });
  });

  it.each(['dismissed', 'open', 'awaiting_evidence'])('refuses to re-sweep a %s case that was never swept: only a finished takedown is swept', async (status) => {
    cases.set('c4', { id: 'c4', status, snapshot: { takedown: { kind: 'global' } }, steps: [] });
    await expect(executeTakedown({ action: 'resweep', caseId: 'c4' }, null)).rejects.toMatchObject({ status: 409 });
    expect((cases.get('c4')!.steps as unknown[]).length).toBe(0);
  });
});
