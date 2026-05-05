import { describe, it, expect, vi, beforeEach } from 'vitest';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  const message = `Given ${given}, should ${should}`;
  expect(actual, message).toEqual(expected);
};

const { mockChannelFindMany, mockDmFindMany } = vi.hoisted(() => ({
  mockChannelFindMany: vi.fn(),
  mockDmFindMany: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      channelMessages: { findMany: mockChannelFindMany },
      directMessages: { findMany: mockDmFindMany },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  inArray: vi.fn((field: unknown, values: unknown[]) => ({ op: 'inArray', field, values })),
}));

vi.mock('@pagespace/db/schema/chat', () => ({
  channelMessages: { id: 'channel_messages.id' },
}));

vi.mock('@pagespace/db/schema/social', () => ({
  directMessages: { id: 'direct_messages.id' },
}));

import { inArray } from '@pagespace/db/operators';
import { attachQuotedMessages } from '../quote-enrichment';

beforeEach(() => {
  vi.clearAllMocks();
  mockChannelFindMany.mockResolvedValue([]);
  mockDmFindMany.mockResolvedValue([]);
});

const channelRow = (id: string, content = 'hi', isActive = true, authorName = 'Alice') => ({
  id,
  content,
  createdAt: new Date('2026-05-05T00:00:00Z'),
  isActive,
  user: { id: 'user-1', name: authorName, image: null },
});

const dmRow = (id: string, content = 'hi', isActive = true) => ({
  id,
  content,
  createdAt: new Date('2026-05-05T00:00:00Z'),
  isActive,
  sender: { id: 'user-2', name: 'Bob', image: null },
});

describe('attachQuotedMessages — query economy', () => {
  it('issues zero queries when no row carries a quotedMessageId', async () => {
    const rows = [{ id: 'r1', quotedMessageId: null }, { id: 'r2', quotedMessageId: null }];

    const result = await attachQuotedMessages(rows, 'channel');

    assert({
      given: 'a batch where no row references a quoted message',
      should: 'short-circuit without hitting the database',
      actual: mockChannelFindMany.mock.calls.length,
      expected: 0,
    });
    assert({
      given: 'a batch with no quotes',
      should: 'still return every row with quotedMessage set to null',
      actual: result.map((r) => r.quotedMessage),
      expected: [null, null],
    });
  });

  it('issues exactly one query when multiple rows carry distinct quotedMessageIds', async () => {
    mockChannelFindMany.mockResolvedValue([channelRow('q1'), channelRow('q2')]);
    const rows = [
      { id: 'r1', quotedMessageId: 'q1' },
      { id: 'r2', quotedMessageId: 'q2' },
    ];

    await attachQuotedMessages(rows, 'channel');

    assert({
      given: 'two distinct quotedMessageIds',
      should: 'collapse to a single batched IN-query, not one per row',
      actual: mockChannelFindMany.mock.calls.length,
      expected: 1,
    });
  });

  it('de-duplicates the IN-list when multiple rows quote the same message', async () => {
    mockChannelFindMany.mockResolvedValue([channelRow('q1')]);
    const rows = [
      { id: 'r1', quotedMessageId: 'q1' },
      { id: 'r2', quotedMessageId: 'q1' },
      { id: 'r3', quotedMessageId: 'q1' },
    ];

    await attachQuotedMessages(rows, 'channel');

    const inArrayCall = vi.mocked(inArray).mock.calls[0];
    assert({
      given: 'three rows pointing at the same quoted id',
      should: 'send a single occurrence of the id in the IN-list',
      actual: (inArrayCall[1] as string[]).length,
      expected: 1,
    });
  });
});

describe('attachQuotedMessages — soft-delete and missing rows', () => {
  it('preserves isActive=false on the snapshot rather than filtering soft-deleted quotes out', async () => {
    mockChannelFindMany.mockResolvedValue([channelRow('q1', 'gone', false)]);
    const rows = [{ id: 'r1', quotedMessageId: 'q1' }];

    const result = await attachQuotedMessages(rows, 'channel');

    assert({
      given: 'a quote pointing at a soft-deleted source',
      should: 'return the snapshot with isActive=false so the renderer can show a tombstone',
      actual: result[0].quotedMessage?.isActive,
      expected: false,
    });
  });

  it('does not filter the IN-query by isActive — soft-deleted rows must still resolve', async () => {
    mockChannelFindMany.mockResolvedValue([]);
    const rows = [{ id: 'r1', quotedMessageId: 'q1' }];

    await attachQuotedMessages(rows, 'channel');

    const callArg = mockChannelFindMany.mock.calls[0][0] as { where: unknown };
    assert({
      given: 'the IN-query for quoted messages',
      should: 'pass only the id-list filter and never an isActive predicate',
      actual: callArg.where,
      expected: { op: 'inArray', field: 'channel_messages.id', values: ['q1'] },
    });
  });

  it('returns null when a quotedMessageId resolves to no row (hard-deleted or unknown)', async () => {
    mockChannelFindMany.mockResolvedValue([]);
    const rows = [{ id: 'r1', quotedMessageId: 'missing' }];

    const result = await attachQuotedMessages(rows, 'channel');

    assert({
      given: 'a quotedMessageId with no matching row',
      should: 'return quotedMessage: null so the renderer can render the tombstone branch',
      actual: result[0].quotedMessage,
      expected: null,
    });
  });
});

describe('attachQuotedMessages — snapshot shape', () => {
  it('truncates the content snippet via the shared 100-char preview helper', async () => {
    const long = 'x'.repeat(150);
    mockChannelFindMany.mockResolvedValue([channelRow('q1', long)]);
    const rows = [{ id: 'r1', quotedMessageId: 'q1' }];

    const result = await attachQuotedMessages(rows, 'channel');

    assert({
      given: 'a quoted message with content longer than 100 chars',
      should: 'truncate to 100 chars + ellipsis, matching buildThreadPreview',
      actual: result[0].quotedMessage?.contentSnippet,
      expected: 'x'.repeat(100) + '...',
    });
  });

  it('reads the author from the user relation on channel scope', async () => {
    mockChannelFindMany.mockResolvedValue([channelRow('q1', 'hi', true, 'Alice')]);
    const rows = [{ id: 'r1', quotedMessageId: 'q1' }];

    const result = await attachQuotedMessages(rows, 'channel');

    assert({
      given: 'a channel-scoped quote',
      should: 'read authorName from the user relation (not sender)',
      actual: result[0].quotedMessage?.authorName,
      expected: 'Alice',
    });
  });

  it('reads the author from the sender relation on dm scope', async () => {
    mockDmFindMany.mockResolvedValue([dmRow('q1')]);
    const rows = [{ id: 'r1', quotedMessageId: 'q1' }];

    const result = await attachQuotedMessages(rows, 'dm');

    assert({
      given: 'a dm-scoped quote',
      should: 'read authorName from the sender relation (DM rows expose sender, not user)',
      actual: result[0].quotedMessage?.authorName,
      expected: 'Bob',
    });
  });

  it('routes the IN-query to channelMessages for channel scope and directMessages for dm scope', async () => {
    mockChannelFindMany.mockResolvedValue([channelRow('q1')]);
    mockDmFindMany.mockResolvedValue([dmRow('q2')]);

    await attachQuotedMessages([{ id: 'r1', quotedMessageId: 'q1' }], 'channel');
    await attachQuotedMessages([{ id: 'r2', quotedMessageId: 'q2' }], 'dm');

    assert({
      given: 'one call per scope',
      should: 'hit channelMessages.findMany for channel and directMessages.findMany for dm',
      actual: {
        channel: mockChannelFindMany.mock.calls.length,
        dm: mockDmFindMany.mock.calls.length,
      },
      expected: { channel: 1, dm: 1 },
    });
  });
});
