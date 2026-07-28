/**
 * Running badges: which conversations (and which agents) currently have a live
 * assistant stream.
 *
 * The shape this has to get right is the collapsed-agent case. A user with a
 * collapsed agent row has never loaded that agent's conversations, so the
 * per-conversation map cannot know about them — but the agent's dot still has to
 * light up, or a background run would be invisible until you happened to expand
 * the right row. Agent attribution therefore comes from the stream's own
 * `channelId` (which IS the agent page id), not from the conversation list.
 */
import { describe, test, expect } from 'vitest';
import { deriveRunningBadges, type UserActiveStream } from '../running-badges';

const stream = (overrides: Partial<UserActiveStream> = {}): UserActiveStream => ({
  messageId: 'msg-1',
  conversationId: 'conv-1',
  channelId: 'agent-1',
  startedAt: '2026-07-28T00:00:00.000Z',
  ...overrides,
});

describe('deriveRunningBadges', () => {
  test('flags a rendered conversation that is streaming', () => {
    const badges = deriveRunningBadges([stream()], ['conv-1', 'conv-2']);
    expect(badges.byConversation).toEqual({ 'conv-1': 1 });
    expect(badges.byAgent).toEqual({ 'agent-1': 1 });
  });

  test('leaves quiet conversations out of the map entirely', () => {
    // Absent rather than `false`/`0`: a row asks "am I running", and one
    // truthiness check is the whole read.
    const badges = deriveRunningBadges([stream()], ['conv-1', 'conv-2']);
    expect(badges.byConversation['conv-2']).toBeUndefined();
  });

  test('counts concurrent streams on one conversation', () => {
    // Two browser tabs, or a user stream plus a shared-conversation stream:
    // callers that only want a dot read it as truthy, and a future "2 running"
    // label gets the number for free.
    const badges = deriveRunningBadges(
      [stream({ messageId: 'msg-1' }), stream({ messageId: 'msg-2' })],
      ['conv-1'],
    );
    expect(badges.byConversation['conv-1']).toBe(2);
    expect(badges.byAgent['agent-1']).toBe(2);
  });

  test('lights an agent whose streaming conversation is not in the rendered list', () => {
    // The collapsed-agent case, and the reason `byAgent` is not derived from
    // `byConversation`.
    const badges = deriveRunningBadges([stream({ conversationId: 'unloaded' })], ['conv-1']);
    expect(badges.byConversation).toEqual({});
    expect(badges.byAgent).toEqual({ 'agent-1': 1 });
  });

  test('sums an agent across several of its conversations', () => {
    const badges = deriveRunningBadges(
      [
        stream({ messageId: 'm1', conversationId: 'conv-1' }),
        stream({ messageId: 'm2', conversationId: 'conv-2' }),
      ],
      ['conv-1', 'conv-2'],
    );
    expect(badges.byAgent).toEqual({ 'agent-1': 2 });
  });

  test('keeps agents apart', () => {
    const badges = deriveRunningBadges(
      [
        stream({ messageId: 'm1', channelId: 'agent-1', conversationId: 'conv-1' }),
        stream({ messageId: 'm2', channelId: 'agent-2', conversationId: 'conv-2' }),
      ],
      ['conv-1', 'conv-2'],
    );
    expect(badges.byAgent).toEqual({ 'agent-1': 1, 'agent-2': 1 });
  });

  test('does not attribute a global-assistant stream to an agent', () => {
    // The global assistant's channel is the synthetic `user:{id}:global`, which
    // is not a page id — counting it as one would invent an agent row keyed by a
    // string no agent has.
    const badges = deriveRunningBadges(
      [stream({ channelId: 'user:user-1:global', conversationId: 'conv-1' })],
      ['conv-1'],
    );
    expect(badges.byAgent).toEqual({});
    // The conversation itself still shows as running — it is a real conversation
    // the tree can render.
    expect(badges.byConversation).toEqual({ 'conv-1': 1 });
  });

  test('each map is fed independently by the field it needs', () => {
    // A row missing one id is not dropped from the other map: a stream with a
    // blank conversationId still tells you its agent is busy, and a stream on a
    // blank channel still tells you that conversation is running. Neither blank
    // is ever used as a key.
    const badges = deriveRunningBadges(
      [stream({ conversationId: '' }), stream({ messageId: 'm2', channelId: '' })],
      ['conv-1', ''],
    );
    expect(badges.byConversation).toEqual({ 'conv-1': 1 });
    expect(badges.byAgent).toEqual({ 'agent-1': 1 });
  });

  test('handles nothing gracefully', () => {
    expect(deriveRunningBadges([], [])).toEqual({ byConversation: {}, byAgent: {} });
    expect(deriveRunningBadges(undefined, undefined)).toEqual({ byConversation: {}, byAgent: {} });
    expect(deriveRunningBadges(undefined, ['conv-1'])).toEqual({ byConversation: {}, byAgent: {} });
  });

  test('deduplicates the rendered-id list without double counting', () => {
    const badges = deriveRunningBadges([stream()], ['conv-1', 'conv-1']);
    expect(badges.byConversation).toEqual({ 'conv-1': 1 });
  });

  test('is pure — it does not mutate its inputs', () => {
    const streams = [stream()];
    const ids = ['conv-1'];
    deriveRunningBadges(streams, ids);
    expect(streams).toEqual([stream()]);
    expect(ids).toEqual(['conv-1']);
  });
});
