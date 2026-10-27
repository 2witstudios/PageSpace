import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, activityHandler, parseArgv } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const ACTIVITY_RESULT = {
  activities: [
    {
      id: 'a1',
      timestamp: '2026-07-01T12:00:00.000Z',
      userId: 'u1',
      actorEmail: 'ada@example.com',
      actorDisplayName: 'Ada',
      isAiGenerated: false,
      aiProvider: null,
      aiModel: null,
      aiConversationId: null,
      operation: 'update',
      resourceType: 'page' as const,
      resourceId: 'p1',
      resourceTitle: 'Design Doc',
      driveId: 'd1',
      pageId: 'p1',
      contentSnapshot: null,
      contentFormat: null,
      contentRef: null,
      contentSize: null,
      rollbackFromActivityId: null,
      rollbackSourceOperation: null,
      rollbackSourceTimestamp: null,
      rollbackSourceTitle: null,
      updatedFields: null,
      previousValues: null,
      newValues: null,
      metadata: null,
      streamId: null,
      streamSeq: null,
      changeGroupId: null,
      changeGroupType: null,
      stateHashBefore: null,
      stateHashAfter: null,
      dataCategory: null,
      legalBasis: null,
      retentionPolicy: null,
      recipients: null,
      isArchived: false,
      chainSeq: 1,
      previousLogHash: null,
      logHash: null,
      chainSeed: null,
      user: { id: 'u1', name: 'Ada', email: 'ada@example.com', image: null },
    },
  ],
  pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
};

describe('activityHandler', () => {
  it('exits 2 with a usage error when driveId is missing', async () => {
    const get = vi.fn(async () => ACTIVITY_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ activity: { get } }) });

    const code = await activityHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(get).not.toHaveBeenCalled();
  });

  it('calls activity.get with context "drive" + the given driveId', async () => {
    const get = vi.fn(async () => ACTIVITY_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ activity: { get } }) });

    const code = await activityHandler(ctx, commandIntent(['d1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(get).toHaveBeenCalledWith({ context: 'drive', driveId: 'd1' });
  });

  it('exits 2 with a usage error given extra positional args', async () => {
    const get = vi.fn(async () => ACTIVITY_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ activity: { get } }) });

    const code = await activityHandler(ctx, commandIntent(['d1', 'extra']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(get).not.toHaveBeenCalled();
  });

  it('renders a timestamped one-line-per-entry feed', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ activity: { get: async () => ACTIVITY_RESULT } }) });

    await activityHandler(ctx, commandIntent(['d1']));

    expect(stdout.lines.join('')).toBe('2026-07-01T12:00:00.000Z  ada@example.com  update page:p1\n');
  });

  it('renders "No activity." when the feed is empty', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      stdout,
      sdk: fakeSdk({ activity: { get: async () => ({ activities: [], pagination: { total: 0, limit: 50, offset: 0, hasMore: false } }) } }),
    });

    await activityHandler(ctx, commandIntent(['d1']));

    expect(stdout.lines.join('')).toBe('No activity.\n');
  });

  it('--json emits exactly the SDK response and nothing else on stdout', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ activity: { get: async () => ACTIVITY_RESULT } }) });

    const code = await activityHandler(ctx, commandIntent(['d1', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(ACTIVITY_RESULT);
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const get = vi.fn(async () => {
      throw new Error('Drive not found');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ activity: { get } }) });

    const code = await activityHandler(ctx, commandIntent(['d1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Drive not found');
  });
});
