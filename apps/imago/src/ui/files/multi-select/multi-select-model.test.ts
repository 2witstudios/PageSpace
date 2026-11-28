import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { selectedCountLabel, trashConfirmBody, trashedToast } from './multi-select-model';

describe('multi-select copy (IMC-9.6)', () => {
  test('the toolbar count', () => {
    assert({ given: 'three pages picked', should: 'read "3 selected"', actual: selectedCountLabel(3), expected: '3 selected' });
  });

  test('the trash confirm names what moves with the pages', () => {
    assert({
      given: 'three pages',
      should: 'say they and their children move to the trash',
      actual: trashConfirmBody(3),
      expected: 'This will move 3 pages and all their children to the trash. You can restore them later.',
    });
  });

  test('the toast after a bulk trash', () => {
    assert({ given: 'three pages trashed', should: 'confirm they moved', actual: trashedToast(3), expected: 'Successfully moved 3 pages to trash' });
  });
});

describe('multi-select copy for one page (IMC-9.6)', () => {
  test('the trash confirm uses the singular for one page', () => {
    assert({
      given: 'one page',
      should: 'say "1 page", not "1 pages"',
      actual: trashConfirmBody(1),
      expected: 'This will move 1 page and all their children to the trash. You can restore them later.',
    });
  });
});
