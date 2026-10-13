import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  segmentClass,
  segmentCountClass,
  segmentedControlClass,
} from './segmented-control-class';

const base =
  'cursor-pointer rounded-sm px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-120 ease-standard focus-visible:shadow-focus';

describe('segmentedControlClass', () => {
  test('the track', () => {
    assert({
      given: 'the group around the segments',
      should: 'draw a quiet overlay track on the control radius, hugging its segments',
      actual: segmentedControlClass,
      expected: 'inline-flex flex-none items-center gap-1 rounded-md bg-surface-overlay p-badge-y',
    });
  });
});

describe('segmentClass', () => {
  test('checked', () => {
    assert({
      given: 'the checked segment',
      should: 'lift it onto the background with the ambient shadow and full ink',
      actual: segmentClass(true),
      expected: `${base} bg-background text-ink shadow-ambient`,
    });
  });

  test('unchecked', () => {
    assert({
      given: 'an unchecked segment',
      should: 'leave it on the track in muted ink that darkens on hover',
      actual: segmentClass(false),
      expected: `${base} text-ink-muted hover:text-ink`,
    });
  });
});

describe('segmentCountClass', () => {
  test('the count after a label', () => {
    assert({
      given: 'a segment count, as in "Mine · 7"',
      should: 'set it in faint ink with tabular figures',
      actual: segmentCountClass,
      expected: 'text-ink-faint tabular-nums',
    });
  });
});
