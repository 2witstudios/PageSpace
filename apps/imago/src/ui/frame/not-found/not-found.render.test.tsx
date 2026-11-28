import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  CHANNEL_NOT_FOUND,
  CONVERSATION_NOT_FOUND,
  PAGE_NOT_FOUND,
  TASK_LIST_NOT_FOUND,
  TASK_NOT_FOUND,
  renderNotFound,
} from './not-found.render';

describe('renderNotFound()', () => {
  test('a drive the viewer cannot open', () => {
    const html = renderToStaticMarkup(
      renderNotFound({ title: 'Drive not found', detail: 'It does not exist, or you do not have access to it.', homeHref: '/home-1' }),
    );

    assert({
      given: 'a title, a detail and the Home drive',
      should: 'render the not-found object with both lines and a way back to Home',
      actual: html,
      expected:
        '<div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center" data-not-found="">' +
        '<h2 class="m-0 text-md font-semibold text-ink">Drive not found</h2>' +
        '<p class="m-0 text-sm text-ink-muted">It does not exist, or you do not have access to it.</p>' +
        '<a class="text-sm font-medium text-accent" href="/home-1">Go to your Home drive</a>' +
        '</div>',
    });
  });

  test('no Home drive yet', () => {
    assert({
      given: 'no Home drive to return to',
      should: 'offer no link',
      actual: renderToStaticMarkup(renderNotFound({ title: 'Drive not found', detail: 'Gone.', homeHref: null })).includes('<a'),
      expected: false,
    });
  });

  test('an id inside a drive that names nothing', () => {
    assert({
      given: 'the section to go back to instead of Home',
      should: 'link back to it under its own label',
      actual: renderToStaticMarkup(
        renderNotFound({ ...TASK_LIST_NOT_FOUND, homeHref: '/d1/tasks', linkLabel: 'Back to Tasks' }),
      ),
      expected:
        '<div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center" data-not-found="">' +
        '<h2 class="m-0 text-md font-semibold text-ink">Task list not found</h2>' +
        '<p class="m-0 text-sm text-ink-muted">It does not exist, or you do not have access to it.</p>' +
        '<a class="text-sm font-medium text-accent" href="/d1/tasks">Back to Tasks</a>' +
        '</div>',
    });
  });

  test('the forms each section names its objects by', () => {
    assert({
      given: 'a page, a channel, a task list, a task and a conversation',
      should: 'title each by what it is and keep one detail that never says whether it exists',
      actual: [PAGE_NOT_FOUND, CHANNEL_NOT_FOUND, TASK_LIST_NOT_FOUND, TASK_NOT_FOUND, CONVERSATION_NOT_FOUND].map(
        ({ title, detail }) => `${title} | ${detail}`,
      ),
      expected: [
        'Page not found | It does not exist, or you do not have access to it.',
        'Channel not found | It does not exist, or you do not have access to it.',
        'Task list not found | It does not exist, or you do not have access to it.',
        'Task not found | It does not exist, or you do not have access to it.',
        'Conversation not found | It does not exist, or you are not part of it.',
      ],
    });
  });
});
