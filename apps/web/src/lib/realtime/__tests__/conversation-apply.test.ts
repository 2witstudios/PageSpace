import { describe, it, expect } from 'vitest';
import {
  decideConversationApply,
  nextWatermark,
  UNVERSIONED_REV,
  type ConversationApplyDecision,
} from '@/lib/realtime/conversation-apply';

/**
 * Exhaustive table tests for the rev apply rule (Agent-Session SSoT epic, Phase 2 /
 * plan PR 3). A later PR property-tests this module; these pin the decision table
 * itself — every (watermark × eventRev × truncated) region, plus the two degenerate
 * revs the docblock names.
 */

describe('decideConversationApply', () => {
  describe('the core rule, against a proven watermark', () => {
    // A small exhaustive sweep: every watermark 0..3 crossed with every rev 0..6,
    // both truncation states. Encoded as the expected decision so a regression in
    // any single cell fails loudly rather than being masked by a happy-path case.
    const expected = (watermark: number, rev: number, truncated: boolean): ConversationApplyDecision => {
      if (rev === UNVERSIONED_REV) return truncated ? 'refetch' : 'apply';
      if (rev <= watermark) return 'drop';
      if (rev === watermark + 1) return (truncated ? 'refetch' : 'apply');
      return 'refetch';
    };

    for (const watermark of [0, 1, 2, 3]) {
      for (const rev of [0, 1, 2, 3, 4, 5, 6]) {
        for (const truncated of [false, true]) {
          it(`watermark ${watermark}, rev ${rev}, truncated ${truncated} → ${expected(watermark, rev, truncated)}`, () => {
            expect(decideConversationApply({ rev, truncated }, watermark)).toBe(
              expected(watermark, rev, truncated),
            );
          });
        }
      }
    }
  });

  it('drops a redelivered event (rev equal to the watermark)', () => {
    expect(decideConversationApply({ rev: 7 }, 7)).toBe('drop');
  });

  it('drops a stale event (rev below the watermark)', () => {
    expect(decideConversationApply({ rev: 3 }, 7)).toBe('drop');
  });

  it('drops a stale event even when it is truncated — refetching what we already have is pure cost', () => {
    expect(decideConversationApply({ rev: 3, truncated: true }, 7)).toBe('drop');
  });

  it('applies the contiguous next rev', () => {
    expect(decideConversationApply({ rev: 8 }, 7)).toBe('apply');
  });

  it('refetches the contiguous next rev when its payload was truncated', () => {
    expect(decideConversationApply({ rev: 8, truncated: true }, 7)).toBe('refetch');
  });

  it('refetches on a gap of one', () => {
    expect(decideConversationApply({ rev: 9 }, 7)).toBe('refetch');
  });

  it('refetches on a large gap (a reconnect that missed a whole burst)', () => {
    expect(decideConversationApply({ rev: 4_096 }, 7)).toBe('refetch');
  });

  it('treats an absent `truncated` field exactly like `false`', () => {
    expect(decideConversationApply({ rev: 8 }, 7)).toBe(
      decideConversationApply({ rev: 8, truncated: false }, 7),
    );
  });

  describe('unversioned events (rev 0 — the emitter had no conversations row)', () => {
    it('applies regardless of how far the watermark has advanced', () => {
      expect(decideConversationApply({ rev: UNVERSIONED_REV }, 0)).toBe('apply');
      expect(decideConversationApply({ rev: UNVERSIONED_REV }, 512)).toBe('apply');
    });

    it('applies even with no watermark at all', () => {
      expect(decideConversationApply({ rev: UNVERSIONED_REV }, null)).toBe('apply');
    });

    it('refetches when truncated, since there is no content to apply', () => {
      expect(decideConversationApply({ rev: UNVERSIONED_REV, truncated: true }, 5)).toBe('refetch');
      expect(decideConversationApply({ rev: UNVERSIONED_REV, truncated: true }, null)).toBe('refetch');
    });
  });

  describe('no proven baseline (watermark null)', () => {
    it('refetches any versioned event — nothing can be proven contiguous against "unknown"', () => {
      expect(decideConversationApply({ rev: 1 }, null)).toBe('refetch');
      expect(decideConversationApply({ rev: 99 }, null)).toBe('refetch');
      expect(decideConversationApply({ rev: 1, truncated: true }, null)).toBe('refetch');
    });
  });

  describe('malformed revs fail toward the server, never toward silence', () => {
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['negative', -1],
    ])('refetches on a %s rev', (_label, rev) => {
      expect(decideConversationApply({ rev: rev as number }, 5)).toBe('refetch');
    });

    it('refetches on a malformed rev even with no watermark', () => {
      expect(decideConversationApply({ rev: Number.NaN }, null)).toBe('refetch');
    });
  });

  it('is pure — the same inputs answer the same way every time', () => {
    const event = { rev: 8, truncated: false };
    const answers = new Set([
      decideConversationApply(event, 7),
      decideConversationApply(event, 7),
      decideConversationApply(event, 7),
    ]);
    expect([...answers]).toEqual(['apply']);
    expect(event).toEqual({ rev: 8, truncated: false });
  });
});

describe('nextWatermark', () => {
  it('adopts the applied rev when it advances the watermark', () => {
    expect(nextWatermark(7, 8)).toBe(8);
  });

  it('adopts the applied rev when there was no watermark', () => {
    expect(nextWatermark(null, 3)).toBe(3);
  });

  it('never moves backwards', () => {
    expect(nextWatermark(9, 4)).toBe(9);
    expect(nextWatermark(9, 9)).toBe(9);
  });

  it('leaves a real watermark untouched for an unversioned apply', () => {
    expect(nextWatermark(9, UNVERSIONED_REV)).toBe(9);
  });

  it('adopts nothing from an unversioned apply with no watermark', () => {
    expect(nextWatermark(null, UNVERSIONED_REV)).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -3],
  ])('ignores a %s rev', (_label, rev) => {
    expect(nextWatermark(5, rev as number)).toBe(5);
    expect(nextWatermark(null, rev as number)).toBeNull();
  });

  it('is monotonic across an arbitrary apply sequence', () => {
    const revs = [1, 2, 5, 3, 5, 9, 0, 7];
    let watermark: number | null = null;
    const seen: Array<number | null> = [];
    for (const rev of revs) {
      watermark = nextWatermark(watermark, rev);
      seen.push(watermark);
    }
    expect(seen).toEqual([1, 2, 5, 5, 5, 9, 9, 9]);
  });
});
