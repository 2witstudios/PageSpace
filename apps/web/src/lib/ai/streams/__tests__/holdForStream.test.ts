import { describe, it, expect } from 'vitest';
import { holdForStream } from '../holdForStream';

describe('holdForStream', () => {
  it('given no stream, should hold nothing', () => {
    expect(holdForStream({ current: null, isStreaming: false, liveValue: 'X' }))
      .toBeNull();
  });

  it('given a stream starting, should capture the surface\'s conversation', () => {
    expect(holdForStream({ current: null, isStreaming: true, liveValue: 'X' }))
      .toBe('X');
  });

  // THE point of this module. useChat does not recreate its Chat when the conversation
  // changes (its id is a constant), so a mid-stream switch does NOT abort the POST — the
  // stream keeps running while the surface moves on. Following the surface here migrated
  // ownership: the running stream's entry was cleared and a fresh claim installed under a
  // conversation with no stream, so the real stream lost its Stop and kept billing.
  it('given the surface switches conversation MID-STREAM, should keep holding the conversation the stream started in', () => {
    expect(holdForStream({ current: 'X', isStreaming: true, liveValue: 'Y' }))
      .toBe('X');
  });

  it('given the stream ends, should release', () => {
    expect(holdForStream({ current: 'X', isStreaming: false, liveValue: 'Y' }))
      .toBeNull();
  });

  it('given the next stream starts after a release, should capture the NEW conversation', () => {
    const afterRelease = holdForStream({ current: 'X', isStreaming: false, liveValue: 'Y' });
    expect(holdForStream({ current: afterRelease, isStreaming: true, liveValue: 'Y' }))
      .toBe('Y');
  });

  // A stream that starts before the surface has resolved its conversation cannot be named,
  // and an un-named stream owns nothing — the store warns rather than silently claiming.
  it('given a stream starts with no conversation resolved yet, should hold nothing', () => {
    expect(holdForStream({ current: null, isStreaming: true, liveValue: null }))
      .toBeNull();
    expect(holdForStream({ current: null, isStreaming: true, liveValue: undefined }))
      .toBeNull();
  });

  // ...and must still be able to capture once it resolves, rather than being stuck at null.
  it('given the conversation resolves after the stream started, should capture it then', () => {
    expect(holdForStream({ current: null, isStreaming: true, liveValue: 'X' }))
      .toBe('X');
  });

  // ── The submitted-window latch ──────────────────────────────────────────────────────────
  //
  // This module latches on the FIRST render where the stream is live — and with the callers'
  // `isStreaming` (which is `status === 'submitted' || status === 'streaming'`), that first
  // render is a SUBMITTED render.
  //
  // useChat sets status='submitted' BEFORE issuing the request, and pushes the new assistant
  // message only inside write(), which flips the status to 'streaming' in the same job. So at
  // the submitted render the array's last assistant message is THE PREVIOUS TURN'S reply.
  //
  // Latching it meant Stop aborted a message that finished minutes ago: the registry no longer
  // knew it, the local fetch stopped, the button LOOKED like it worked, and the real generation
  // kept running its write tools and kept billing. On every turn after the first.
  //
  // The fix is at the callers — they must feed `liveValue: status === 'streaming' ? id : null`
  // — so what this pins is the property that makes that fix WORK: a null liveValue while the
  // stream is live must not latch, and must stay capturable once the real id arrives.
  describe('the submitted-window latch', () => {
    it('given the stream is live but the live id is not yet knowable, should hold nothing rather than latch a wrong id', () => {
      expect(holdForStream({ current: null, isStreaming: true, liveValue: null }))
        .toBeNull();
    });

    it('THE BUG: after holding nothing through submitted, should capture THIS stream\'s id on the first streaming render', () => {
      // submitted: caller passes null (status !== 'streaming'), so nothing is latched...
      const held = holdForStream({ current: null, isStreaming: true, liveValue: null });
      expect(held).toBeNull();
      // ...streaming: the real assistant message has now been pushed. Capture THAT.
      expect(holdForStream({ current: held, isStreaming: true, liveValue: 'M_new' }))
        .toBe('M_new');
    });

    it('given the id was captured, should keep holding it for the rest of the stream', () => {
      expect(holdForStream({ current: 'M_new', isStreaming: true, liveValue: 'M_new' }))
        .toBe('M_new');
    });

    it('given the stream ends, should release so the NEXT turn captures its own id and not this one', () => {
      expect(holdForStream({ current: 'M_new', isStreaming: false, liveValue: 'M_new' }))
        .toBeNull();
    });
  });


  // ── Cross-contamination between two concurrent streams on one surface ────────────────────
  //
  // The dashboard hosts TWO independent chats (agent and global) and both can be in flight at
  // once — switching mode does NOT abort the running POST, because useChat's id is constant.
  //
  // Feeding ONE mode-selected liveValue into BOTH hold-refs let the IDLE mode's ref latch the
  // ACTIVE mode's messageId and pin it. Stop, back in the other mode, then aborted the WRONG
  // stream: one answer died mid-sentence while the other kept running its write tools and kept
  // billing, its Stop permanently wired to an id that was never its own.
  //
  // The fix is at the caller (each ref is fed its OWN chat's id). What this pins is the reducer
  // property that makes it work: a ref whose stream is live but whose own id is not yet known
  // must latch NOTHING, so it stays capturable — it must never be fillable from elsewhere.
  describe('two concurrent streams on one surface', () => {
    it("THE BUG: a live stream with no id of its own yet must not latch, so it cannot be filled with the OTHER stream's id", () => {
      // Global stream is live but still in 'submitted' — its own id is unknowable, so the caller
      // passes null. If this latched anything here, the next render (when the AGENT's id becomes
      // the mode-selected value) would have pinned the agent's id onto the global ref.
      const globalRef = holdForStream({ current: null, isStreaming: true, liveValue: null });
      expect(globalRef).toBeNull();

      // The agent's stream starts and reaches 'streaming'. Its ref captures ITS id.
      const agentRef = holdForStream({ current: null, isStreaming: true, liveValue: 'M_agent' });
      expect(agentRef).toBe('M_agent');

      // The global ref, still live, still without its own id, must STILL hold nothing.
      expect(holdForStream({ current: globalRef, isStreaming: true, liveValue: null })).toBeNull();

      // ...and when the global stream finally produces its own id, it captures THAT.
      expect(holdForStream({ current: globalRef, isStreaming: true, liveValue: 'M_global' }))
        .toBe('M_global');
    });

    it('given both streams have captured, each holds its own id independently', () => {
      expect(holdForStream({ current: 'M_agent', isStreaming: true, liveValue: 'M_agent' }))
        .toBe('M_agent');
      expect(holdForStream({ current: 'M_global', isStreaming: true, liveValue: 'M_global' }))
        .toBe('M_global');
    });

    it('given one stream ends, it releases without disturbing the other', () => {
      expect(holdForStream({ current: 'M_agent', isStreaming: false, liveValue: 'M_agent' }))
        .toBeNull();
      expect(holdForStream({ current: 'M_global', isStreaming: true, liveValue: 'M_global' }))
        .toBe('M_global');
    });
  });

});
