// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ApiError } from '@/api/errors';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { PageResolver } from './page-resolver';

const replace = vi.hoisted(() => vi.fn());
const pageState = vi.hoisted(() => ({ data: undefined as unknown, error: undefined as unknown, mutate: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/ui/files/page-object/page-object', () => ({
  usePage: () => ({ data: pageState.data, error: pageState.error, mutate: pageState.mutate }),
}));

const render = (homeDriveId: string | null = 'home-1') => mount(<PageResolver pageId="page-1" homeDriveId={homeDriveId} />);

describe('PageResolver', () => {
  beforeEach(() => {
    replace.mockClear();
    pageState.data = undefined;
    pageState.error = undefined;
  });
  afterEach(() => unmountAll());

  test('a resolvable id', () => {
    pageState.data = { driveId: 'drive-9', isTrashed: false };
    const container = render();

    assert({
      given: 'a page the viewer may open in drive drive-9',
      should: 'show "Opening page…" and replace to that page in its drive',
      actual: { text: container.textContent, replaced: replace.mock.calls },
      expected: { text: 'Opening page…', replaced: [['/drive-9/files/page-1']] },
    });
  });

  test('a trashed page', () => {
    pageState.data = { driveId: 'drive-9', isTrashed: true };
    const container = render();

    assert({
      given: 'a page in the trash',
      should: 'render the page-unavailable middle and not navigate',
      actual: { unavailable: container.textContent?.includes('This page isn’t available'), replaced: replace.mock.calls.length },
      expected: { unavailable: true, replaced: 0 },
    });
  });

  test('a forbidden page', () => {
    pageState.error = new ApiError({ status: 403, code: null, message: 'forbidden' });
    const container = render();

    assert({
      given: 'a page the viewer may not open',
      should: 'render the page-unavailable middle with no error detail',
      actual: container.querySelector('[data-page-unavailable]') !== null,
      expected: true,
    });
  });

  test('a server failure', () => {
    pageState.error = new ApiError({ status: 500, code: null, message: 'boom' });
    const container = render();

    assert({
      given: 'a 500 from the page API',
      should: 'offer a retry instead of the unavailable middle',
      actual: { error: container.querySelector('[data-error]') !== null, unavailable: container.querySelector('[data-page-unavailable]') !== null },
      expected: { error: true, unavailable: false },
    });
  });
});
