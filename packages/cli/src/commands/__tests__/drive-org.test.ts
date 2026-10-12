import { describe, expect, it } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  drivesAnswerJoinHandler,
  drivesCreateHandler,
  drivesMoveOutOfOrgHandler,
  drivesMoveToOrgHandler,
  drivesRequestJoinHandler,
  drivesSetVisibilityHandler,
  extractDriveCreateArgs,
  parseArgv,
  renderDrivesList,
  renderJoinRequests,
  renderAlwaysOwnCredits,
  walletsAlwaysOwnCreditsHandler,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const ROW = {
  id: 'd1',
  name: 'Research',
  slug: 'research',
  ownerId: 'u1',
  kind: 'STANDARD' as const,
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  drivePrompt: null,
  publishSubdomain: null,
  homePageId: null,
  publishDefaultOgImageUrl: null,
  orgId: 'o1',
  orgVisibility: 'RESTRICTED' as const,
};
const MOVED = { drive: ROW, storageReattribution: { status: 'applied' as const, direction: 'into_org', movedBytes: 0, deltas: [] } };
const JOIN_REQUEST = { id: 'jr1', driveId: 'd1', userId: 'u2', status: 'pending' as const, message: null, requestedAt: '2026-09-17T00:00:00.000Z', decidedAt: null, decidedBy: null };

describe('drives create --org (pure)', () => {
  it('X-1 (partial) a name alone is a personal drive; --org makes it org-owned from creation (DRV-3)', () => {
    expect(extractDriveCreateArgs(['Mine'])).toEqual({ ok: true, value: { name: 'Mine' } });
    expect(extractDriveCreateArgs(['Research', '--org', 'o1', '--visibility', 'RESTRICTED'])).toEqual({
      ok: true,
      value: { name: 'Research', orgId: 'o1', orgVisibility: 'RESTRICTED' },
    });
    expect(extractDriveCreateArgs(['Research', '--visibility', 'OPEN']).ok).toBe(false);
    expect(extractDriveCreateArgs(['Research', '--org', 'o1', '--visibility', 'SECRET']).ok).toBe(false);
    expect(extractDriveCreateArgs([]).ok).toBe(false);
  });

  it('X-1 (partial) the handler sends the org fields to drives.create', async () => {
    const calls: unknown[] = [];
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { create: async (input: unknown) => (calls.push(input), { id: 'd9', name: 'Research' }) } }) });
    expect(await drivesCreateHandler(ctx, commandIntent(['Research', '--org', 'o1']))).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([{ name: 'Research', orgId: 'o1' }]);
  });

  it('X-1 (partial) drives list shows which org owns a drive and its visibility', () => {
    const base = { id: 'd1', name: 'Research', slug: 'r', ownerId: 'u1', kind: 'STANDARD' as const, isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: '', updatedAt: '', isOwned: true, role: 'OWNER' as const, lastAccessedAt: null, homePageId: null };
    expect(renderDrivesList([{ ...base, orgId: 'o1', orgVisibility: 'PRIVATE' }])).toBe('d1  Research  [STANDARD] (OWNER)  org o1 · PRIVATE\n');
    expect(renderDrivesList([{ ...base, orgId: null, orgVisibility: 'OPEN' }])).toBe('d1  Research  [STANDARD] (OWNER)\n');
  });
});

describe('pagespace drives <org verbs>', () => {
  it('X-1 (partial) move-to-org sends the org and optional visibility', async () => {
    const calls: unknown[] = [];
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { moveToOrg: async (input: unknown) => (calls.push(input), MOVED) } }), stdout });
    expect(await drivesMoveToOrgHandler(ctx, commandIntent(['d1', 'o1', '--visibility', 'RESTRICTED']))).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([{ driveId: 'd1', orgId: 'o1', orgVisibility: 'RESTRICTED' }]);
    expect(stdout.lines.join('')).toContain('Moved Research (d1) into organization o1 as RESTRICTED');
  });

  it('X-1 (partial) move-out-of-org needs the keep|remove choice and --yes', async () => {
    let called = false;
    const sdk = fakeSdk({ drives: { moveOutOfOrg: async () => ((called = true), { ...MOVED, drive: { ...ROW, orgId: null } }) } });
    expect(await drivesMoveOutOfOrgHandler(createFakeContext({ sdk }), commandIntent(['d1']))).toBe(EXIT_USAGE_ERROR);
    expect(await drivesMoveOutOfOrgHandler(createFakeContext({ sdk }), commandIntent(['d1', 'maybe', '--yes']))).toBe(EXIT_USAGE_ERROR);
    expect(await drivesMoveOutOfOrgHandler(createFakeContext({ sdk }), commandIntent(['d1', 'keep']))).toBe(EXIT_RUNTIME_ERROR);
    expect(called).toBe(false);
    expect(await drivesMoveOutOfOrgHandler(createFakeContext({ sdk }), commandIntent(['d1', 'remove', '--yes']))).toBe(EXIT_SUCCESS);
    expect(called).toBe(true);
  });

  it('X-1 (partial) set-visibility and answer-join take closed vocabularies', async () => {
    expect(await drivesSetVisibilityHandler(createFakeContext(), commandIntent(['d1', 'open']))).toBe(EXIT_USAGE_ERROR);
    expect(await drivesAnswerJoinHandler(createFakeContext(), commandIntent(['d1', 'jr1', 'yes']))).toBe(EXIT_USAGE_ERROR);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      sdk: fakeSdk({ drives: { answerJoinRequest: async () => ({ request: { ...JOIN_REQUEST, status: 'approved' }, admitted: true }) } }),
      stdout,
    });
    expect(await drivesAnswerJoinHandler(ctx, commandIntent(['d1', 'jr1', 'approve']))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toBe('Request jr1 approved; the requester is now a member.\n');
  });

  it('X-1 (partial) request-join passes the optional message', async () => {
    const calls: unknown[] = [];
    const ctx = createFakeContext({ sdk: fakeSdk({ drives: { requestToJoin: async (input: unknown) => (calls.push(input), { request: JOIN_REQUEST }) } }) });
    expect(await drivesRequestJoinHandler(ctx, commandIntent(['d1', '--message', 'please']))).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([{ driveId: 'd1', message: 'please' }]);
  });

  it('X-1 (partial) join requests render one line each', () => {
    expect(renderJoinRequests({ requests: [{ id: 'jr1', userId: 'u2', name: 'Lena', email: 'l@x.co', image: null, message: 'hi', requestedAt: '2026-09-17T00:00:00.000Z' }] })).toBe(
      '  jr1  Lena <l@x.co>  asked 2026-09-17  "hi"\n',
    );
    expect(renderJoinRequests({ requests: [] })).toBe('No pending join requests.\n');
  });
});

describe('pagespace wallets always-own-credits', () => {
  it('X-1 (partial) reads the switches, the drive one with --drive', async () => {
    const calls: unknown[] = [];
    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      sdk: fakeSdk({ wallets: { getAlwaysOwnCredits: async (input: unknown) => (calls.push(input), { alwaysOwnCredits: false, alwaysOwnCreditsInDrive: true }) } }),
      stdout,
    });
    expect(await walletsAlwaysOwnCreditsHandler(ctx, commandIntent(['--drive', 'd1']))).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([{ driveId: 'd1' }]);
    expect(stdout.lines.join('')).toBe('Always my own credits: off\n  in drive d1: on\n');
    expect(renderAlwaysOwnCredits({ alwaysOwnCredits: true, alwaysOwnCreditsInDrive: false }, undefined)).toBe('Always my own credits: on\n');
    expect(await walletsAlwaysOwnCreditsHandler(createFakeContext(), commandIntent(['extra']))).toBe(EXIT_USAGE_ERROR);
  });
});
