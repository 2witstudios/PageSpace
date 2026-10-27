import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { matchesHotkeyFilter } from './hotkey-filter';

const hotkey = { label: 'Quick Create Page', description: 'Open the quick-create palette to create a new page' };

describe('matchesHotkeyFilter', () => {
  test('an empty or blank query keeps every shortcut', () => {
    assert({
      given: 'a blank filter query',
      should: 'keep the shortcut',
      actual: [matchesHotkeyFilter(hotkey, ''), matchesHotkeyFilter(hotkey, '   ')],
      expected: [true, true],
    });
  });

  test('matches the label and the description, ignoring case', () => {
    assert({
      given: 'a query matching the label in a different case, and one matching only the description',
      should: 'keep the shortcut for both',
      actual: [matchesHotkeyFilter(hotkey, 'quick CREATE'), matchesHotkeyFilter(hotkey, 'palette')],
      expected: [true, true],
    });
  });

  test('drops a shortcut that matches neither', () => {
    assert({
      given: 'a query that matches neither the label nor the description',
      should: 'filter the shortcut out',
      actual: matchesHotkeyFilter(hotkey, 'zoom'),
      expected: false,
    });
  });
});
