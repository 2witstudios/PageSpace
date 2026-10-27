import { describe, it, expect } from 'vitest';
import { deriveStreamingRegistrations } from '../deriveStreamingRegistrations';
import type { PendingStream, PendingStreamsMap } from '@/stores/pendingStreams/applyAddStream';

const stream = (over: Partial<PendingStream> & { messageId: string }): PendingStream => ({
  pageId: 'page-1',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'u1', displayName: 'You' },
  parts: [],
  isOwn: false,
  ...over,
});

const mapOf = (...entries: PendingStream[]): PendingStreamsMap =>
  new Map(entries.map((e) => [e.messageId, e]));

describe('deriveStreamingRegistrations', () => {
  it('given nothing pending and nothing streaming, should register nothing', () => {
    expect(deriveStreamingRegistrations({ pendingSends: new Set(), streams: new Map() }))
      .toEqual([]);
  });

  // The editing-store contract (repo CLAUDE.md): registration gates SWR revalidation AND
  // auth-token refresh. It must be continuous from the send CLICK — not from the first token —
  // or the 0.5-3s TTFB window is unprotected and an SWR revalidation lands mid-send.
  it('given a pending send, should register that conversation before any stream exists', () => {
    expect(deriveStreamingRegistrations({ pendingSends: new Set(['conv-1']), streams: new Map() }))
      .toEqual(['conv-1']);
  });

  // The other half of the continuity: by the time the stream is live, useSendHandoff has cleared
  // the pendingSend (its end-condition is precisely "a store entry exists"). The store entry
  // carries the registration from there to the end of the stream.
  it('given a live stream and no pending send, should register that conversation', () => {
    expect(deriveStreamingRegistrations({
      pendingSends: new Set(),
      streams: mapOf(stream({ messageId: 'm1', conversationId: 'conv-1', isOwn: true })),
    })).toEqual(['conv-1']);
  });

  // The handoff instant itself — both true at once. Exactly one registration, not two: the
  // registration is keyed by CONVERSATION, which is what makes co-mounted surfaces (GVA and the
  // sidebar are co-mounted after one dashboard visit) collapse to a single session instead of
  // each registering their own.
  it('given a pending send AND a live stream for the same conversation, should register it exactly once', () => {
    expect(deriveStreamingRegistrations({
      pendingSends: new Set(['conv-1']),
      streams: mapOf(stream({ messageId: 'm1', conversationId: 'conv-1', isOwn: true })),
    })).toEqual(['conv-1']);
  });

  // A BOOTSTRAPPED stream (refresh mid-stream) has no pendingSend owner — nobody in this tab
  // ever clicked send for it. This is the gap the old useChat-status-based registration left
  // open: useChat sits at idle after a refresh, so the surface reported "not streaming" and SWR
  // was free to clobber the replayed stream. Store presence closes it.
  it('given a bootstrapped stream with no pending send, should still register it', () => {
    expect(deriveStreamingRegistrations({
      pendingSends: new Set(),
      streams: mapOf(stream({ messageId: 'm1', conversationId: 'conv-1', isOwn: true })),
    })).toEqual(['conv-1']);
  });

  // Remote streams count too: a stream someone else started in a conversation this tab is
  // showing is still live content being written into the page, and an SWR revalidation
  // underneath it is the same clobber.
  it('given only a remote stream, should register its conversation', () => {
    expect(deriveStreamingRegistrations({
      pendingSends: new Set(),
      streams: mapOf(stream({ messageId: 'm1', conversationId: 'conv-1', isOwn: false })),
    })).toEqual(['conv-1']);
  });

  it('given streams and sends across several conversations, should register each conversation once', () => {
    expect(deriveStreamingRegistrations({
      pendingSends: new Set(['conv-3']),
      streams: mapOf(
        stream({ messageId: 'm1', conversationId: 'conv-1' }),
        stream({ messageId: 'm2', conversationId: 'conv-2' }),
        stream({ messageId: 'm3', conversationId: 'conv-1' }),
      ),
    })).toEqual(['conv-1', 'conv-2', 'conv-3']);
  });

  // THE FALLING EDGE (leaf 5.7.1). Registration ends when the store entry is REMOVED — which
  // happens on stream_complete/abort — and not a moment earlier. Deriving it from useChat's
  // status ended it at the status flip, which is a different (earlier) instant than the store
  // entry's removal on every path where the two disagree: bootstrap, remote, cross-instance.
  it('given a stream that ends, should stop registering only once the store entry is gone', () => {
    const live = mapOf(stream({ messageId: 'm1', conversationId: 'conv-1', isOwn: true }));
    expect(deriveStreamingRegistrations({ pendingSends: new Set(), streams: live })).toEqual(['conv-1']);

    const ended: PendingStreamsMap = new Map();
    expect(deriveStreamingRegistrations({ pendingSends: new Set(), streams: ended })).toEqual([]);
  });

  // Order is part of the contract: the caller diffs this result against the previous one to
  // decide what to start/end, and an unstable order would make an unchanged set look changed.
  it('given the same membership in a different insertion order, should return a stable, sorted result', () => {
    const a = deriveStreamingRegistrations({
      pendingSends: new Set(['conv-b', 'conv-a']),
      streams: mapOf(stream({ messageId: 'm1', conversationId: 'conv-c' })),
    });
    const b = deriveStreamingRegistrations({
      pendingSends: new Set(['conv-a', 'conv-b']),
      streams: mapOf(stream({ messageId: 'm1', conversationId: 'conv-c' })),
    });
    expect(a).toEqual(['conv-a', 'conv-b', 'conv-c']);
    expect(a).toEqual(b);
  });
});
