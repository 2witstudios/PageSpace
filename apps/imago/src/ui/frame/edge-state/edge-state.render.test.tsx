// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ApiError } from '@/api/errors';
import { click, mount, unmountAll } from '../../test-support/dom';
import { ERROR_DETAIL, edgeOf, renderEmptyState, renderErrorState, renderLoadingState } from './edge-state.render';

afterEach(unmountAll);

describe('renderEmptyState()', () => {
  test('a section with nothing in it yet', () => {
    assert({
      given: 'a title and a detail',
      should: 'render the quiet empty object with both lines',
      actual: renderToStaticMarkup(
        renderEmptyState({ title: 'No task lists yet', detail: 'Task lists in this drive show up here.' }),
      ),
      expected:
        '<div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center" data-empty="">' +
        '<h2 class="m-0 text-md font-semibold text-ink">No task lists yet</h2>' +
        '<p class="m-0 text-sm text-ink-muted">Task lists in this drive show up here.</p>' +
        '</div>',
    });
  });
});

describe('renderEmptyState() with an action', () => {
  test('an empty place the viewer can fill', () => {
    assert({
      given: 'a title, a detail and an action',
      should: 'put the action under the two lines, inside the same quiet empty object',
      actual: renderToStaticMarkup(
        renderEmptyState({
          title: 'This folder is empty',
          detail: 'Pages you add here show up in it.',
          action: <button type="button">New page</button>,
        }),
      ),
      expected:
        '<div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center" data-empty="">' +
        '<h2 class="m-0 text-md font-semibold text-ink">This folder is empty</h2>' +
        '<p class="m-0 text-sm text-ink-muted">Pages you add here show up in it.</p>' +
        '<button type="button">New page</button>' +
        '</div>',
    });
  });
});

describe('renderLoadingState()', () => {
  test('an object on its way', () => {
    assert({
      given: 'what is loading',
      should: 'say so in one quiet status line',
      actual: renderToStaticMarkup(renderLoadingState('Loading page…')),
      expected: '<p role="status" class="p-4 text-sm text-ink-muted">Loading page…</p>',
    });
  });
});

describe('renderErrorState()', () => {
  test('a request that failed', () => {
    assert({
      given: 'a title and a retry action',
      should: 'render an alert with the title, the one safe detail and a Try again button',
      actual: renderToStaticMarkup(renderErrorState({ title: 'Could not load this task list', retry: () => {} })),
      expected:
        '<div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center" role="alert" data-error="">' +
        '<h2 class="m-0 text-md font-semibold text-ink">Could not load this task list</h2>' +
        `<p class="m-0 text-sm text-ink-muted">${ERROR_DETAIL}</p>` +
        '<button type="button" class="inline-flex h-control cursor-pointer items-center justify-center gap-2 rounded-md border text-base leading-tight font-medium transition-colors duration-120 ease-standard border-border-strong bg-transparent px-4 text-ink hover:border-ink-muted">Try again</button>' +
        '</div>',
    });
  });

  test('Try again', () => {
    const retry = vi.fn();
    const container = mount(renderErrorState({ title: 'Could not load channels', retry }));
    const button = container.querySelector('button');
    if (button === null) throw new Error('no Try again button');
    click(button);

    assert({
      given: 'a click on Try again',
      should: 'call the retry action once',
      actual: retry.mock.calls.length,
      expected: 1,
    });
  });
});

describe('edgeOf()', () => {
  const api = (status: number) => new ApiError({ status, code: null, message: `server text ${status}` });

  test('answers that mean the id names nothing the viewer can open', () => {
    assert({
      given: 'a 404 and a 403 from apps/web',
      should: 'both be not-found, never saying which',
      actual: [edgeOf(api(404)), edgeOf(api(403))],
      expected: ['not-found', 'not-found'],
    });
  });

  test('failures worth asking again', () => {
    assert({
      given: 'a 500, a 400, a network TypeError and an unknown throw',
      should: 'be errors, which a retry may fix',
      actual: [edgeOf(api(500)), edgeOf(api(400)), edgeOf(new TypeError('Failed to fetch')), edgeOf('boom')],
      expected: ['error', 'error', 'error', 'error'],
    });
  });
});
