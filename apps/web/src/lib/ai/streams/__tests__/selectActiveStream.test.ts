import { describe, it, expect } from 'vitest';
import { selectActiveStream } from '../selectActiveStream';
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

describe('selectActiveStream', () => {
  // The whole point of PR 5A: "is a stream live, and how do I stop it" becomes a READ of the
  // store, not a slot somebody has to claim. Absence is a real answer — it means "nothing is
  // live for this conversation", which is what the composer/Stop button render from.
  it('given no streams at all, should report no active stream', () => {
    expect(selectActiveStream(new Map(), { pageId: 'page-1', conversationId: 'conv-1' }))
      .toBeUndefined();
  });

  it('given a live own stream for this conversation, should report it as own', () => {
    const streams = mapOf(stream({ messageId: 'm1', isOwn: true }));
    expect(selectActiveStream(streams, { pageId: 'page-1', conversationId: 'conv-1' }))
      .toEqual({ messageId: 'm1', conversationId: 'conv-1', isOwn: true });
  });

  it('given a live REMOTE stream for this conversation, should report it as not own', () => {
    const streams = mapOf(stream({ messageId: 'm1', isOwn: false }));
    expect(selectActiveStream(streams, { pageId: 'page-1', conversationId: 'conv-1' }))
      .toEqual({ messageId: 'm1', conversationId: 'conv-1', isOwn: false });
  });

  // Conversation scoping. A channel (global channel or agent page) carries EVERY conversation
  // on it — "send → New Chat → send" leaves two live own streams on the same channel. Each
  // must be stoppable from its own conversation, and neither may light up the other's Stop.
  it('given a live stream in a DIFFERENT conversation on the same channel, should report no active stream', () => {
    const streams = mapOf(stream({ messageId: 'm1', conversationId: 'other-conv', isOwn: true }));
    expect(selectActiveStream(streams, { pageId: 'page-1', conversationId: 'conv-1' }))
      .toBeUndefined();
  });

  it('given two live own streams in different conversations, should report each under its own conversation', () => {
    const streams = mapOf(
      stream({ messageId: 'm1', conversationId: 'conv-1', isOwn: true }),
      stream({ messageId: 'm2', conversationId: 'conv-2', isOwn: true }),
    );
    expect(selectActiveStream(streams, { pageId: 'page-1', conversationId: 'conv-1' })?.messageId).toBe('m1');
    expect(selectActiveStream(streams, { pageId: 'page-1', conversationId: 'conv-2' })?.messageId).toBe('m2');
  });

  // Page scoping, carried over from PR 4's useActiveStream facade: a stream read that skipped
  // the page scope would reach across channels. Kept here so the scope rule lives in ONE tested
  // unit rather than being re-derived per surface.
  it('given a live stream on a DIFFERENT page, should report no active stream', () => {
    const streams = mapOf(stream({ messageId: 'm1', pageId: 'other-page', isOwn: true }));
    expect(selectActiveStream(streams, { pageId: 'page-1', conversationId: 'conv-1' }))
      .toBeUndefined();
  });

  // Own-vs-remote precedence. A shared conversation can carry both a remote stream and this
  // tab's own; Stop must name OURS, because ours is the one whose local fetch we can also
  // cancel — and the server abort for someone else's stream is not ours to issue first.
  it('given both an own and a remote stream for this conversation, should prefer the own stream regardless of insertion order', () => {
    const remoteFirst = mapOf(
      stream({ messageId: 'remote', isOwn: false }),
      stream({ messageId: 'mine', isOwn: true }),
    );
    expect(selectActiveStream(remoteFirst, { pageId: 'page-1', conversationId: 'conv-1' })?.messageId).toBe('mine');

    const ownFirst = mapOf(
      stream({ messageId: 'mine', isOwn: true }),
      stream({ messageId: 'remote', isOwn: false }),
    );
    expect(selectActiveStream(ownFirst, { pageId: 'page-1', conversationId: 'conv-1' })?.messageId).toBe('mine');
  });

  // The submitted window (send clicked, no assistant message pushed yet, no store entry).
  // Deliberately ABSENT rather than a synthetic "streaming" entry: the stop path has a
  // separate, correct answer for this window (abort by the send-time conversationId), and
  // inventing an entry with no messageId here would hand it a name that names nothing.
  // See decideStopAction.
  it('given the submitted window has not yet produced a store entry, should report no active stream', () => {
    expect(selectActiveStream(new Map(), { pageId: 'page-1', conversationId: 'conv-1' }))
      .toBeUndefined();
  });

  // Identity not yet resolved. Every surface renders at least once before it knows which
  // conversation it is showing; a null id must not match a stream whose conversationId is
  // (correctly) a string.
  it('given no conversation resolved yet, should report no active stream', () => {
    const streams = mapOf(stream({ messageId: 'm1', isOwn: true }));
    expect(selectActiveStream(streams, { pageId: 'page-1', conversationId: null })).toBeUndefined();
  });

  it('given no page resolved yet, should report no active stream', () => {
    const streams = mapOf(stream({ messageId: 'm1', isOwn: true }));
    expect(selectActiveStream(streams, { pageId: null, conversationId: 'conv-1' })).toBeUndefined();
  });

  // A projection, NOT the store entry: `parts` grows on every token, so returning the entry
  // itself would give every Stop-button consumer a new reference per token. The three fields
  // the stop/streaming machinery actually needs are all primitives, so a shallow-compared
  // selector over this projection is stable for a stream's whole life.
  it('given a stream whose parts are growing, should project a value that does not change per token', () => {
    const before = selectActiveStream(
      mapOf(stream({ messageId: 'm1', isOwn: true, parts: [{ type: 'text', text: 'He' }] })),
      { pageId: 'page-1', conversationId: 'conv-1' },
    );
    const after = selectActiveStream(
      mapOf(stream({ messageId: 'm1', isOwn: true, parts: [{ type: 'text', text: 'Hello' }] })),
      { pageId: 'page-1', conversationId: 'conv-1' },
    );
    expect(after).toEqual(before);
  });
});
