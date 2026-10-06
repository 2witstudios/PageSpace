import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { badgeClass, badgeTones } from './badge-class';

const base =
  'inline-flex items-center gap-1 rounded-md px-badge-x py-badge-y text-xs leading-tight font-medium whitespace-nowrap';

describe('badgeClass()', () => {
  test('tones', () => {
    assert({
      given: 'each badge tone',
      should: 'add exactly that tone to the md-radius base',
      actual: badgeTones.map(badgeClass),
      expected: [
        `${base} bg-surface-overlay text-ink-muted`,
        `${base} bg-accent-soft text-accent`,
      ],
    });
  });

  test('never red', () => {
    assert({
      given: 'every badge tone',
      should: 'never use the red live color (counts and status read in the accent)',
      actual: badgeTones.filter((tone) => /\b(bg|text)-live/.test(badgeClass(tone))),
      expected: [],
    });
  });
});
