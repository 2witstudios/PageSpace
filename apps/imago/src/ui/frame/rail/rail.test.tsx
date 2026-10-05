// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createApiClient } from '@/api/client';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import { mount, unmountAll } from '../../test-support/dom';
import { paneLayout, stageFor } from '../stage/stage';
import { Rail } from './rail';

/** apps/web's badges route as the browser sees it: a fake fetch behind the real imago client. */
const badgesClient = (body: unknown, status = 200) => {
  const requests: string[] = [];
  const client = createApiClient({
    fetch: async (input) => {
      requests.push(input);
      return Response.json(body, { status });
    },
    navigate: () => {},
    location: () => ({ origin: 'http://localhost:3006', pathname: '/imago/drive-1' }),
  });
  return { client, requests };
};

const railAt = (pathname: string, body: unknown = { dms: 0, channels: 0, files: 0, tasks: 0, calendar: 0 }) => {
  const api = badgesClient(body);
  const stage = stageFor(pathname);
  const layout = paneLayout(stage, getUiState().resources);
  const container = mount(
    <ImagoSWRProvider client={api.client}>
      <Rail stage={stage} layout={layout} homeDriveId="home-1" footer={null} />
    </ImagoSWRProvider>,
  );
  return { container, requests: api.requests };
};

const settle = (check: () => void): Promise<void> =>
  act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

/**
 * Clicks the disclosure's summary. The browser flips `open` at once but fires
 * `toggle` as a later task, and only that event reaches React's state.
 */
const toggleMore = async (container: HTMLElement): Promise<void> => {
  const details = container.querySelector('details');
  const toggled = new Promise<void>((resolve) => {
    details?.addEventListener('toggle', () => resolve(), { once: true });
  });
  act(() => control(container, 'More').click());
  await act(() => toggled);
};

const control = (container: HTMLElement, name: string): HTMLElement => {
  const element = container.querySelector(`[aria-label="${name}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no control named ${name}`);
  return element;
};

beforeEach(() => {
  setUiState(createInitialState());
});

afterEach(() => {
  unmountAll();
});

describe('Rail', () => {
  test('the Messages unread count from /api/sidebar/badges', async () => {
    const { container, requests } = railAt('/drive-1', { dms: 2, channels: 5, files: 9, tasks: 1, calendar: 3 });
    await settle(() => {
      control(container, 'Messages, 7 unread');
    });
    const badge = control(container, 'Messages, 7 unread').querySelector('[aria-hidden="true"].bg-accent');

    assert({
      given: 'two unread DMs and five unread channel messages',
      should: 'load the badges once through the imago client and show 7 on Messages in the accent badge',
      actual: [requests, badge?.textContent, container.querySelectorAll('.bg-accent').length],
      expected: [['/api/sidebar/badges'], '7', 1],
    });
  });

  test('a failed badges request', async () => {
    const api = badgesClient({ error: 'Failed to fetch sidebar badges' }, 500);
    const stage = stageFor('/drive-1');
    const container = mount(
      <ImagoSWRProvider client={api.client}>
        <Rail stage={stage} layout={paneLayout(stage, getUiState().resources)} homeDriveId={null} footer={null} />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (api.requests.length === 0) throw new Error('not requested');
    });

    assert({
      given: 'the badges route failing',
      should: 'keep the rail and show no count',
      actual: [control(container, 'Messages').tagName, container.querySelector('.bg-accent')],
      expected: ['A', null],
    });
  });

  test('links to the current drive', () => {
    const { container } = railAt('/drive-1/tasks/list-1');
    const hrefs = ['Chat', 'Files', 'Messages', 'Tasks', 'Settings'].map((name) =>
      control(container, name).getAttribute('href'),
    );

    assert({
      given: 'a task list open in drive-1',
      should: 'link every item into drive-1 and mark Tasks current',
      actual: [hrefs, control(container, 'Tasks').getAttribute('aria-current'), container.querySelectorAll('[aria-current]').length],
      expected: [['/drive-1', '/drive-1/files', '/drive-1/messages', '/drive-1/tasks', '/drive-1/settings'], 'page', 1],
    });
  });

  test('a user-level stage links into the Home drive', () => {
    const { container } = railAt('/dm/conversation-1');

    assert({
      given: 'a DM, which names no drive',
      should: 'link into the Home drive and keep Messages current',
      actual: [control(container, 'Files').getAttribute('href'), control(container, 'Messages').getAttribute('aria-current')],
      expected: ['/home-1/files', 'page'],
    });
  });

  test('clicking the active item of a collapsed section', () => {
    dispatch(transactions.collapseSection, 'files');
    const { container } = railAt('/drive-1/files/page-1');
    act(() => control(container, 'Files').click());

    assert({
      given: 'the files tree hidden beside an open page, and Files clicked',
      should: 'reopen the files list through the store',
      actual: getUiState().resources.collapsedSections,
      expected: [],
    });
  });

  test('only the active item reopens', () => {
    dispatch(transactions.collapseSection, 'files');
    dispatch(transactions.collapseSection, 'tasks');
    const { container } = railAt('/drive-1/files/page-1');
    const tasks = control(container, 'Tasks');
    // Next's Link navigates on a click nobody prevented; stop it at the anchor.
    const navigated = vi.fn((event: Event) => event.preventDefault());
    tasks.addEventListener('click', navigated);
    act(() => tasks.click());

    assert({
      given: 'files and tasks both collapsed, on a files page, and Tasks clicked',
      should: 'navigate as a link and leave both sections collapsed',
      actual: [navigated.mock.calls.length, getUiState().resources.collapsedSections],
      expected: [1, ['files', 'tasks']],
    });
  });

  test('the overflow menu', async () => {
    const { container } = railAt('/drive-1');
    const details = container.querySelector('details');
    await toggleMore(container);
    const opened = [...container.querySelectorAll('details a')].map((link) => link.getAttribute('href'));

    act(() => {
      details?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    const afterEscape = details?.open;

    await toggleMore(container);
    const reopened = details?.open;
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    assert({
      given: '⋯ clicked, then Escape, then ⋯ again and a click outside',
      should: 'open the classic deep links for this drive, and close on Escape and on an outside click',
      actual: [opened, afterEscape, reopened, details?.open],
      expected: [
        [
          '/dashboard/drive-1/calendar',
          '/dashboard/drive-1/agents',
          '/dashboard/drive-1/settings/integrations',
          '/dashboard/drive-1/activity',
          '/dashboard/drive-1/trash',
        ],
        false,
        true,
        false,
      ],
    });
  });
});
