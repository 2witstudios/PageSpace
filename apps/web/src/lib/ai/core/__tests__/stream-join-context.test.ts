import { describe, it, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const { mockSessionRow, mockLoggerWarn } = vi.hoisted(() => ({
  mockSessionRow: vi.fn<() => Promise<unknown[]>>(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => mockSessionRow() }),
      }),
    }),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: {
    messageId: 'ai_stream_sessions.message_id',
    channelId: 'ai_stream_sessions.channel_id',
    userId: 'ai_stream_sessions.user_id',
    displayName: 'ai_stream_sessions.display_name',
    conversationId: 'ai_stream_sessions.conversation_id',
    browserSessionId: 'ai_stream_sessions.browser_session_id',
    status: 'ai_stream_sessions.status',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
}));

import { resolveStreamJoinContext } from '../stream-join-context';
import { streamChannelRegistry, type StreamMeta } from '../stream-channel-registry';

const META: StreamMeta = {
  pageId: 'page-abc',
  userId: 'user-a',
  displayName: 'Alice',
  conversationId: 'conv-1',
  browserSessionId: 'session-1',
};

const row = (over: Record<string, unknown> = {}) => ({
  channelId: 'page-abc',
  userId: 'user-a',
  displayName: 'Alice',
  conversationId: 'conv-1',
  browserSessionId: 'session-1',
  status: 'streaming',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  streamChannelRegistry.reset();
  mockSessionRow.mockResolvedValue([]);
});

describe('resolveStreamJoinContext', () => {
  it('given a channel this process owns, answers local with the live channel', async () => {
    const channel = streamChannelRegistry.open('msg-local', META);

    const context = await resolveStreamJoinContext('msg-local');

    assert({
      given: 'a generation running on this instance',
      should: 'answer local, carrying the registry\'s own channel object',
      actual: { kind: context.kind, sameChannel: context.kind === 'local' && context.channel === channel },
      expected: { kind: 'local', sameChannel: true },
    });
  });

  it('given a locally-owned channel, never reads the DB', async () => {
    streamChannelRegistry.open('msg-local', META);

    await resolveStreamJoinContext('msg-local');

    assert({
      given: 'a registry hit',
      should: 'skip the session-row read — the live object is authoritative and a round trip buys nothing',
      actual: mockSessionRow.mock.calls.length,
      expected: 0,
    });
  });

  it('given a registry miss and a streaming row, answers remote — not missing', async () => {
    mockSessionRow.mockResolvedValue([row()]);

    const context = await resolveStreamJoinContext('msg-elsewhere');

    // THE BUG THIS LEAF FIXES. At N>1 the channel registry is a process-local Map, so a join
    // that load-balances anywhere but the generating instance found nothing — and the route
    // 404'd, saying "no such stream" about a stream that was very much running.
    assert({
      given: 'a live generation owned by another web instance',
      should: 'answer remote',
      actual: context.kind,
      expected: 'remote',
    });
  });

  it('maps the row to EXACTLY the StreamMeta shape the registry produces', async () => {
    mockSessionRow.mockResolvedValue([row()]);

    const context = await resolveStreamJoinContext('msg-elsewhere');

    // This is the whole trick: because the shape is identical, the route's authz block runs
    // VERBATIM over DB-sourced meta. A drift here would silently mean a second, weaker
    // authorization path for cross-instance joins.
    assert({
      given: 'a session row',
      should: 'produce meta with pageId ← channelId and every other field one-for-one',
      actual: context.kind === 'remote' ? context.meta : null,
      expected: META,
    });
  });

  it('given a completed row, answers terminal rather than missing', async () => {
    mockSessionRow.mockResolvedValue([row({ status: 'complete' })]);

    const context = await resolveStreamJoinContext('msg-done');

    assert({
      given: 'a generation that finished',
      should: 'say so, so a client can reload the durable message instead of reading "never existed"',
      actual: context.kind === 'terminal' ? { kind: context.kind, aborted: context.aborted } : { kind: context.kind },
      expected: { kind: 'terminal', aborted: false },
    });
  });

  it('given an aborted row, answers terminal with aborted set', async () => {
    mockSessionRow.mockResolvedValue([row({ status: 'aborted' })]);

    const context = await resolveStreamJoinContext('msg-stopped');

    assert({
      given: 'a generation that was stopped',
      should: 'carry aborted, the same distinction a local end already makes',
      actual: context.kind === 'terminal' ? context.aborted : null,
      expected: true,
    });
  });

  it('given neither a channel nor a row, answers missing', async () => {
    assert({
      given: 'a messageId nothing knows about',
      should: 'answer missing — the only honest 404',
      actual: (await resolveStreamJoinContext('msg-nowhere')).kind,
      expected: 'missing',
    });
  });

  it('given a read that fails, degrades to missing rather than guessing', async () => {
    mockSessionRow.mockRejectedValue(new Error('db down'));

    const context = await resolveStreamJoinContext('msg-unreadable');

    // The same degradation the route had before this module existed (a registry miss 404'd
    // unconditionally), so a DB blip costs a joiner a retry rather than a wrong answer about
    // who may see what.
    assert({
      given: 'a session-row read that threw',
      should: 'answer missing and warn',
      actual: { kind: context.kind, warned: mockLoggerWarn.mock.calls.length > 0 },
      expected: { kind: 'missing', warned: true },
    });
  });

  it('does not treat a half-torn-down registry entry as local', async () => {
    // `getMeta` and `get` are set and cleared together, so requiring BOTH is defence in depth —
    // but serving `local` with no channel would hand the route a context it cannot subscribe to.
    streamChannelRegistry.open('msg-racing', META);
    vi.spyOn(streamChannelRegistry, 'get').mockReturnValue(undefined);
    mockSessionRow.mockResolvedValue([row()]);

    const context = await resolveStreamJoinContext('msg-racing');

    assert({
      given: 'meta present but the channel already gone',
      should: 'fall through to the row rather than claim a local channel',
      actual: context.kind,
      expected: 'remote',
    });
  });
});
