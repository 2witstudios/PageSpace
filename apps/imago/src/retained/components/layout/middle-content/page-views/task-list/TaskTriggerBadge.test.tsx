// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { TaskTriggerBadge } from './TaskTriggerBadge';

afterEach(unmountAll);

const LABEL = 'Agent trigger configured — click to edit';

describe('TaskTriggerBadge', () => {
  test('shows the active trigger count with the trigger name and no summary text', () => {
    const container = mount(createElement(TaskTriggerBadge, { count: 1, onOpen: vi.fn() }));
    const badge = container.querySelector(`button[aria-label="${LABEL}"]`);
    assert({
      given: 'a task with one active trigger',
      should: 'show the count of 1 on the badge and nothing else as its text',
      actual: badge?.textContent,
      expected: '1',
    });
  });

  test('renders nothing for a task with no active triggers', () => {
    const container = mount(createElement(TaskTriggerBadge, { count: 0, onOpen: vi.fn() }));
    assert({
      given: 'a task with no active triggers',
      should: 'render no badge',
      actual: container.querySelector('button') === null,
      expected: true,
    });
  });

  test('opens the trigger dialog when pressed', () => {
    const onOpen = vi.fn();
    const container = mount(createElement(TaskTriggerBadge, { count: 2, onOpen }));
    const badge = container.querySelector('button');
    if (badge) click(badge);
    assert({
      given: 'a badge for two triggers',
      should: 'call onOpen once on press',
      actual: onOpen.mock.calls.length,
      expected: 1,
    });
  });
});
