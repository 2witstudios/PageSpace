// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { StatusConfigManager } from './StatusConfigManager';

afterEach(unmountAll);

const triggerText = (triggerLabel?: string) => {
  const container = mount(
    createElement(StatusConfigManager, {
      pageId: 'list',
      statusConfigs: [],
      onConfigsChanged: vi.fn(),
      ...(triggerLabel === undefined ? {} : { triggerLabel }),
    }),
  );
  return container.querySelector('button')?.textContent ?? null;
};

describe('StatusConfigManager trigger', () => {
  test('is named "Manage statuses" on the list strip', () => {
    assert({
      given: 'the list strip passes its status label',
      should: 'label the trigger "Manage statuses"',
      actual: triggerText('Manage statuses'),
      expected: 'Manage statuses',
    });
  });

  test('is named "Edit statuses" on the board', () => {
    assert({
      given: 'the board passes its status label',
      should: 'label the trigger "Edit statuses"',
      actual: triggerText('Edit statuses'),
      expected: 'Edit statuses',
    });
  });

  test('keeps "Statuses" when no label is passed, as the drive-wide surfaces do', () => {
    assert({
      given: 'no label is passed',
      should: 'keep the default "Statuses" trigger',
      actual: triggerText(),
      expected: 'Statuses',
    });
  });
});
