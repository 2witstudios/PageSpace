// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createApiClient } from '@/api/client';
import { mount, unmountAll } from '../../test-support/dom';
import { usePaletteSearch, type PaletteSearch } from './use-palette-search';

type Sent = { readonly url: string; readonly signal: AbortSignal | undefined; readonly answer: (body: unknown, status?: number) => void };

/**
 * The real imago client over a fetch the test answers by hand, so a test
 * decides when, and in what order, each search comes back.
 */
const deferredWeb = () => {
  const sent: Sent[] = [];
  const client = createApiClient({
    fetch: (input, init) =>
      new Promise<Response>((resolve) => {
        sent.push({
          url: input,
          signal: init?.signal ?? undefined,
          answer: (body, status = 200) => resolve(Response.json(body, { status })),
        });
      }),
    navigate: () => {},
    location: () => ({ origin: 'http://localhost:3006', pathname: '/imago/d-1' }),
  });
  return { client, sent };
};

const page = (id: string, title: string) => ({ id, label: title, type: 'page', data: { pageType: 'DOCUMENT', driveId: 'd-1' } });

let seen: PaletteSearch = { status: 'idle', results: [] };

function Probe({ path, client, delayMs }: { path: string | null; client: ReturnType<typeof deferredWeb>['client']; delayMs: number }) {
  seen = usePaletteSearch(path, { client, delayMs });
  return null;
}

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

afterEach(() => {
  unmountAll();
  seen = { status: 'idle', results: [] };
});

describe('usePaletteSearch()', () => {
  test('one search', async () => {
    const web = deferredWeb();
    const container = mount(<Probe path="/api/mentions/search?q=road" client={web.client} delayMs={20} />);
    const before = { status: seen.status, sent: web.sent.length };
    await settle(() => {
      if (web.sent.length !== 1) throw new Error('not sent');
    });
    await act(async () => web.sent[0]?.answer([page('p-1', 'Roadmap')]));
    await settle(() => {
      if (seen.status !== 'done') throw new Error('not done');
    });

    assert({
      given: 'a query, before the pause and after the server answers',
      should: 'say it is searching without asking yet, then ask once and list the answer',
      actual: [before, web.sent.map((request) => request.url), seen],
      expected: [
        { status: 'loading', sent: 0 },
        ['/api/mentions/search?q=road'],
        { status: 'done', results: [{ id: 'p-1', title: 'Roadmap', pageType: 'DOCUMENT', driveId: 'd-1' }] },
      ],
    });
    container.remove();
  });

  test('typing quickly', async () => {
    const web = deferredWeb();
    let setPath: (path: string) => void = () => {};
    function Typing() {
      const [path, set] = useState('/api/mentions/search?q=r');
      setPath = set;
      seen = usePaletteSearch(path, { client: web.client, delayMs: 40 });
      return null;
    }
    mount(<Typing />);
    act(() => setPath('/api/mentions/search?q=ro'));
    act(() => setPath('/api/mentions/search?q=road'));
    await settle(() => {
      if (web.sent.length !== 1) throw new Error('not sent');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    assert({
      given: 'three keystrokes inside the pause',
      should: 'ask only for the last query',
      actual: web.sent.map((request) => request.url),
      expected: ['/api/mentions/search?q=road'],
    });
  });

  test('answers out of order', async () => {
    const web = deferredWeb();
    let setPath: (path: string) => void = () => {};
    function Typing() {
      const [path, set] = useState('/api/mentions/search?q=ro');
      setPath = set;
      seen = usePaletteSearch(path, { client: web.client, delayMs: 1 });
      return null;
    }
    mount(<Typing />);
    await settle(() => {
      if (web.sent.length !== 1) throw new Error('first not sent');
    });
    act(() => setPath('/api/mentions/search?q=road'));
    await settle(() => {
      if (web.sent.length !== 2) throw new Error('second not sent');
    });
    const [stale, fresh] = web.sent;
    const abortedBeforeAnswers = [stale?.signal?.aborted, fresh?.signal?.aborted];
    await act(async () => fresh?.answer([page('p-2', 'Road trip')]));
    await settle(() => {
      if (seen.status !== 'done') throw new Error('not done');
    });
    await act(async () => stale?.answer([page('p-1', 'Rotation')]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    assert({
      given: '"ro" still in flight when "road" is asked, and "road" answering first',
      should: 'cancel the "ro" request and keep the "road" answer when the stale one arrives',
      actual: [abortedBeforeAnswers, seen.results.map((result) => result.title)],
      expected: [[true, false], ['Road trip']],
    });
  });

  test('a new query after an answer', async () => {
    const web = deferredWeb();
    let setPath: (path: string) => void = () => {};
    function Typing() {
      const [path, set] = useState('/api/mentions/search?q=road');
      setPath = set;
      seen = usePaletteSearch(path, { client: web.client, delayMs: 1 });
      return null;
    }
    mount(<Typing />);
    await settle(() => {
      if (web.sent.length !== 1) throw new Error('not sent');
    });
    await act(async () => web.sent[0]?.answer([page('p-1', 'Roadmap')]));
    await settle(() => {
      if (seen.status !== 'done') throw new Error('not done');
    });
    act(() => setPath('/api/mentions/search?q=roads'));

    assert({
      given: '"road" answered and "roads" typed, before "roads" answers',
      should: 'list nothing rather than the answer for "road", which Enter would open',
      actual: seen,
      expected: { status: 'loading', results: [] },
    });
  });

  test('a failed search', async () => {
    const web = deferredWeb();
    mount(<Probe path="/api/mentions/search?q=road&driveId=d-9" client={web.client} delayMs={1} />);
    await settle(() => {
      if (web.sent.length !== 1) throw new Error('not sent');
    });
    await act(async () => web.sent[0]?.answer({ error: 'Access denied to the specified drive' }, 403));
    await settle(() => {
      if (seen.status !== 'error') throw new Error('no error');
    });

    assert({
      given: 'the server refusing the search',
      should: 'list nothing and say it failed',
      actual: seen,
      expected: { status: 'error', results: [] },
    });
  });

  test('nothing to ask', () => {
    const web = deferredWeb();
    mount(<Probe path={null} client={web.client} delayMs={1} />);

    assert({
      given: 'no search path',
      should: 'ask nothing and list nothing',
      actual: [seen, web.sent.length],
      expected: [{ status: 'idle', results: [] }, 0],
    });
  });
});
