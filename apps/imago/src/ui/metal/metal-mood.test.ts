import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { MOODS, MOOD_KEYS, detailFor, moodFor } from './metal-mood';

describe('moodFor()', () => {
  test('a turn under way', () => {
    assert({
      given: 'a sent message waiting, then its reply streaming, with the composer focused or not',
      should: 'think, then speak, whatever the composer is doing',
      actual: [
        moodFor({ phase: 'thinking', composerFocused: true }),
        moodFor({ phase: 'speaking', composerFocused: false }),
      ],
      expected: ['thinking', 'speaking'],
    });
  });

  test('no turn under way', () => {
    assert({
      given: 'nothing streaming, with the composer focused and then not',
      should: 'listen while the viewer is in the composer, and idle otherwise',
      actual: [moodFor({ phase: null, composerFocused: true }), moodFor({ phase: null, composerFocused: false })],
      expected: ['listening', 'idle'],
    });
  });
});

describe('MOODS', () => {
  test('every mood sets every parameter', () => {
    assert({
      given: 'the mood table',
      should: 'give each mood the same parameters',
      actual: Object.values(MOODS).every((targets) => Object.keys(targets).join() === MOOD_KEYS.join()),
      expected: true,
    });
  });

  test('one orb', () => {
    assert({
      given: 'any mood',
      should: 'keep its bulges inside the orb, so it never reads as separate pieces',
      actual: Object.values(MOODS).every((m) => m.bulge < m.core && m.swell < m.bulge),
      expected: true,
    });
  });
});

describe('detailFor()', () => {
  test('size classes', () => {
    assert({
      given: 'a hero, an avatar and a glyph-sized orb',
      should: 'carry three bulges with full choreography, two with half the folds, and one with mood only',
      actual: [detailFor(120), detailFor(30), detailFor(16)],
      expected: [
        { drops: 4, churnScale: 1, wobbleScale: 1, pulses: true },
        { drops: 3, churnScale: 0.5, wobbleScale: 1, pulses: true },
        { drops: 2, churnScale: 0, wobbleScale: 0.5, pulses: false },
      ],
    });
  });
});
