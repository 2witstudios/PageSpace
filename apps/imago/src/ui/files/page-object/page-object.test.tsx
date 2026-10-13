// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { click, mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { PageObject, pageEdgeOf } from './page-object';

afterEach(unmountAll);

const PAGE = 'GET /api/pages/p1';

const page = (overrides: Record<string, unknown> = {}): FakeRoute => () =>
  Response.json({ id: 'p1', title: 'Notes', type: 'DOCUMENT', driveId: 'd1', isTrashed: false, ...overrides });

const show = (routes: Record<string, FakeRoute>) => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <PageObject driveId="d1" pageId="p1">
        <p data-page-content="">the page</p>
      </PageObject>
    </ImagoSWRProvider>,
  );
  return { web, container };
};

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

const notFound = (container: HTMLElement) => {
  const object = container.querySelector('[data-not-found]');
  return [object?.querySelector('h2')?.textContent, object?.querySelector('a')?.getAttribute('href'), object?.querySelector('a')?.textContent];
};

describe('PageObject', () => {
  test('a page of this drive', async () => {
    const { container } = show({ [PAGE]: page() });
    await settle(() => {
      if (!container.querySelector('[data-page-content]')) throw new Error('not shown');
    });
    assert({
      given: 'a page the viewer can open, in the drive the address names',
      should: 'show the object’s content and no edge state',
      actual: [container.querySelector('[data-not-found], [data-error]'), container.textContent],
      expected: [null, 'the page'],
    });
  });

  test('while it loads', () => {
    const { container } = show({ [PAGE]: () => new Promise<Response>(() => {}) });
    assert({
      given: 'a page still on its way',
      should: 'say it is loading, and show nothing of the page yet',
      actual: [container.querySelector('[role="status"]')?.textContent, container.querySelector('[data-page-content]')],
      expected: ['Loading page…', null],
    });
  });

  test('ids that name nothing the viewer can open here', async () => {
    const cases: readonly [string, FakeRoute][] = [
      ['an unknown id (404)', () => Response.json({ error: 'Page not found' }, { status: 404 })],
      ['a page the viewer may not view (403)', () => Response.json({ error: 'You do not have permission' }, { status: 403 })],
      ['a page of another drive', page({ driveId: 'd2' })],
      ['a trashed page', page({ isTrashed: true })],
    ];
    const actual: unknown[] = [];
    for (const [name, route] of cases) {
      const { container } = show({ [PAGE]: route });
      await settle(() => {
        if (!container.querySelector('[data-not-found]')) throw new Error(`${name}: no not-found`);
      });
      actual.push([name, ...notFound(container), container.querySelector('[data-page-content]')]);
      unmountAll();
    }
    assert({
      given: 'a 404, a 403, a page of another drive and a trashed page',
      should: 'each draw the same not-found object with a way back to the drive’s files',
      actual,
      expected: cases.map(([name]) => [name, 'Page not found', '/d1/files', 'Back to Files', null]),
    });
  });

  test('a page that will not load, then loads', async () => {
    let calls = 0;
    const { container, web } = show({
      [PAGE]: (request) => {
        calls += 1;
        return calls === 1 ? Response.json({ error: 'syntax error at or near "FROM"' }, { status: 500 }) : page()(request);
      },
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"] button')) throw new Error('no retry');
    });
    const alert = container.querySelector('[role="alert"]');
    const failed = [alert?.querySelector('h2')?.textContent, alert?.textContent?.includes('syntax')];
    click(alert?.querySelector('button') as HTMLButtonElement);
    await settle(() => {
      if (!container.querySelector('[data-page-content]')) throw new Error('not reloaded');
    });
    assert({
      given: 'a 500 with server text, then Try again',
      should: 'draw the retryable error without that text, then the page SWR loads on retry',
      actual: [failed, web.count(PAGE), container.querySelector('[role="alert"]')],
      expected: [['Could not load this page', false], 2, null],
    });
  });
});

describe('pageEdgeOf()', () => {
  test('an answer imago cannot read as a page', () => {
    assert({
      given: 'a null body and a page with no drive',
      should: 'be not-found rather than drawing a page it cannot place',
      actual: [pageEdgeOf(null, undefined, 'd1'), pageEdgeOf({ id: 'p1' }, undefined, 'd1')],
      expected: ['not-found', 'not-found'],
    });
  });
});
