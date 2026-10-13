import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { PAGE_TYPE_VALUES } from '@pagespace/lib/utils/enums';
import { iconNames } from '../icon/icon-names';
import { pageTypeIcons } from './page-type-icon';

describe('pageTypeIcons (IMC-1.5)', () => {
  test('every page type', () => {
    assert({
      given: 'every PageType',
      should: 'have an icon imago draws and a type hue',
      actual: PAGE_TYPE_VALUES.filter((type) => !iconNames.includes(pageTypeIcons[type].icon) || !pageTypeIcons[type].hue.startsWith('text-type-')),
      expected: [],
    });
  });

  test('the board hues', () => {
    assert({
      given: 'a channel and a folder',
      should: 'be purple and amber',
      actual: [pageTypeIcons.CHANNEL.hue, pageTypeIcons.FOLDER.hue],
      expected: ['text-type-channel', 'text-type-folder'],
    });
  });
});
