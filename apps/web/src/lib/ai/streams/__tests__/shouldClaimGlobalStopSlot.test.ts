import { describe, it, expect } from 'vitest';
import { shouldClaimGlobalStopSlot } from '../shouldClaimGlobalStopSlot';

const claim = (o: Partial<Parameters<typeof shouldClaimGlobalStopSlot>[0]> = {}) =>
  shouldClaimGlobalStopSlot({
    incomingMessageId: 'M1',
    incomingConversationId: 'C1',
    heldMessageId: null,
    heldConversationId: null,
    activeConversationId: 'C1',
    ...o,
  });

describe('shouldClaimGlobalStopSlot', () => {
  describe('conversation scoping', () => {
    it('claims a stream belonging to the conversation on screen', () => {
      expect(claim()).toBe(true);
    });

    it('given a stream for a DIFFERENT resolved conversation, should refuse — that Stop button is not ours to light', () => {
      expect(claim({ incomingConversationId: 'C2', activeConversationId: 'C1' })).toBe(false);
    });

    it('given identity not yet resolved, should still claim — a null active id means UNKNOWN, not "no conversation"', () => {
      // The tolerant claim exists because the DB bootstrap routinely lands before the surface
      // has resolved its conversation. Rejecting here would drop the very stream we are about
      // to render.
      expect(claim({ activeConversationId: null })).toBe(true);
    });
  });

  describe('single-writer', () => {
    it('claims a free slot', () => {
      expect(claim({ heldMessageId: null })).toBe(true);
    });

    it('re-claiming the stream we already hold is idempotent', () => {
      expect(claim({ heldMessageId: 'M1', heldConversationId: 'C1' })).toBe(true);
    });

    it('THE BUG: a second own stream must not evict an equally-certain incumbent', () => {
      // Both claims made in ignorance, in one bootstrap sweep. The unconditional claim let M2
      // overwrite M1 — M1's finalize was then dropped, and with no re-claim protocol the slot
      // could be left holding a stream the user is not looking at, forever.
      expect(
        claim({
          incomingMessageId: 'M2',
          incomingConversationId: 'C2',
          heldMessageId: 'M1',
          heldConversationId: 'C1',
          activeConversationId: null,
        }),
      ).toBe(false);
    });

    it('given two live own streams and a RESOLVED identity, should let the exact match evict a claim made in ignorance', () => {
      // M1 claimed while identity was unknown (so it named C1 but could not prove it was the
      // one on screen). Identity then resolved to C2, and M2 is the stream actually on screen.
      // M2 is strictly more certain, so it takes the slot.
      expect(
        claim({
          incomingMessageId: 'M2',
          incomingConversationId: 'C2',
          heldMessageId: 'M1',
          heldConversationId: 'C1',
          activeConversationId: 'C2',
        }),
      ).toBe(true);
    });

    it('given an incumbent that already matches the resolved conversation, should refuse to evict it', () => {
      // Two live streams in ONE conversation should be impossible (takeover), but if it happens
      // the incumbent is no less certain than we are — first writer wins rather than thrash.
      expect(
        claim({
          incomingMessageId: 'M2',
          incomingConversationId: 'C1',
          heldMessageId: 'M1',
          heldConversationId: 'C1',
          activeConversationId: 'C1',
        }),
      ).toBe(false);
    });

    it('given an unresolved identity and an incumbent, should never evict — we cannot prove we are the better claim', () => {
      expect(
        claim({
          incomingMessageId: 'M2',
          incomingConversationId: 'C1',
          heldMessageId: 'M1',
          heldConversationId: 'C1',
          activeConversationId: null,
        }),
      ).toBe(false);
    });
  });
});
