import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { sourceLabel, statusVariant } from './utils';

describe('backup source and status pills', () => {
  test('sourceLabel names each source the way the board does', () => {
    assert({
      given: 'each backup source',
      should: 'show Manual, Scheduled, Safety snapshot and System',
      actual: ['manual', 'scheduled', 'pre_restore', 'system'].map(sourceLabel),
      expected: ['Manual', 'Scheduled', 'Safety snapshot', 'System'],
    });
  });

  test('statusVariant maps ready, failed and pending to their pill styles', () => {
    assert({
      given: 'the three backup statuses',
      should: 'give ready the default pill, failed the destructive one and pending the secondary one',
      actual: ['ready', 'failed', 'pending'].map(statusVariant),
      expected: ['default', 'destructive', 'secondary'],
    });
  });
});
