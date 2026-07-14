import { describe, it, expect } from 'vitest';
import { planOwnStreamMirror } from '../planOwnStreamMirror';

const BASE = {
  pageId: 'page-1',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'u1', displayName: 'Me' },
  startedAt: '2024-01-01T00:00:00.000Z',
  seq: 1,
};

const text = (t: string) => ({ type: 'text' as const, text: t });

describe('planOwnStreamMirror', () => {
  it('given no active stream and nothing mirrored, should plan no ops', () => {
    const ops = planOwnStreamMirror({
      ...BASE,
      status: 'ready',
      ownAssistantMessage: undefined,
      mirroredMessageId: undefined,
    });
    expect(ops).toEqual([]);
  });

  it('given the stream has ended but a stale mirror entry remains, should plan removeStream', () => {
    const ops = planOwnStreamMirror({
      ...BASE,
      status: 'ready',
      ownAssistantMessage: undefined,
      mirroredMessageId: 'a1',
    });
    expect(ops).toEqual([{ type: 'removeStream', messageId: 'a1' }]);
  });

  it('given an error status with a stale mirror entry, should also plan removeStream', () => {
    const ops = planOwnStreamMirror({
      ...BASE,
      status: 'error',
      ownAssistantMessage: undefined,
      mirroredMessageId: 'a1',
    });
    expect(ops).toEqual([{ type: 'removeStream', messageId: 'a1' }]);
  });

  it('given a fresh stream start (streaming, nothing mirrored yet), should plan addStream then setStreamParts', () => {
    const ops = planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'a1', parts: [text('hi')] },
      mirroredMessageId: undefined,
    });
    expect(ops).toEqual([
      {
        type: 'addStream',
        stream: {
          messageId: 'a1',
          pageId: 'page-1',
          conversationId: 'conv-1',
          triggeredBy: { userId: 'u1', displayName: 'Me' },
          isOwn: true,
          startedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      { type: 'setStreamParts', messageId: 'a1', parts: [text('hi')], seq: 1 },
    ]);
  });

  it('given a submitted status (before the first chunk lands) with the assistant message already present, should treat it as active', () => {
    const ops = planOwnStreamMirror({
      ...BASE,
      status: 'submitted',
      ownAssistantMessage: { id: 'a1', parts: [] },
      mirroredMessageId: undefined,
    });
    expect(ops[0]).toMatchObject({ type: 'addStream' });
  });

  it('given the same message already mirrored, should plan only setStreamParts', () => {
    const ops = planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'a1', parts: [text('hi there')] },
      mirroredMessageId: 'a1',
    });
    expect(ops).toEqual([{ type: 'setStreamParts', messageId: 'a1', parts: [text('hi there')], seq: 1 }]);
  });

  it('given the mirrored id differs from the current assistant message id, should remove the stale entry before adding the new one', () => {
    const ops = planOwnStreamMirror({
      ...BASE,
      status: 'streaming',
      ownAssistantMessage: { id: 'a2', parts: [text('new')] },
      mirroredMessageId: 'a1',
    });
    expect(ops[0]).toEqual({ type: 'removeStream', messageId: 'a1' });
    expect(ops[1]).toMatchObject({ type: 'addStream', stream: { messageId: 'a2' } });
    expect(ops[2]).toEqual({ type: 'setStreamParts', messageId: 'a2', parts: [text('new')], seq: 1 });
  });

  it('given submitted status with no assistant message pushed yet and nothing mirrored, should plan no ops', () => {
    const ops = planOwnStreamMirror({
      ...BASE,
      status: 'submitted',
      ownAssistantMessage: undefined,
      mirroredMessageId: undefined,
    });
    expect(ops).toEqual([]);
  });

  it('given identical input called twice, should produce deep-equal ops both times (idempotent)', () => {
    const input = {
      ...BASE,
      status: 'streaming' as const,
      ownAssistantMessage: { id: 'a1', parts: [text('hi')] },
      mirroredMessageId: 'a1',
    };
    expect(planOwnStreamMirror(input)).toEqual(planOwnStreamMirror(input));
  });
});
