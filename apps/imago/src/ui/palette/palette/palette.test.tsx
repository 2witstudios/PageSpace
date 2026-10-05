// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import type { DriveSummary } from '../../frame/drives/drives';
import { stageFor } from '../../frame/stage/stage';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { click, mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';

const router = vi.hoisted(() => ({ pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => router.pushed.push(href) }),
}));

const { CommandPalette } = await import('./palette');

const drives: DriveSummary[] = [
  { id: 'home-1', name: 'Home', kind: 'HOME' },
  { id: 'd-1', name: 'Alpha', kind: 'STANDARD' },
  { id: 'd-2', name: 'Beta', kind: 'STANDARD' },
];

const page = (id: string, label: string, pageType: string, driveId: string) => ({
  id,
  label,
  type: 'page',
  data: { pageType, driveId },
  description: `${pageType.toLowerCase()} · ${id}`,
});

/** What apps/web's search answers for "road" in Alpha, and across every drive. */
const inAlpha = [
  page('p-1', 'Roadmap', 'DOCUMENT', 'd-1'),
  page('p-2', 'road-crew', 'CHANNEL', 'd-1'),
  page('p-3', 'Road tasks', 'TASK_LIST', 'd-1'),
];
const everywhere = [
  page('p-1', 'Roadmap', 'DOCUMENT', 'd-1'),
  page('a-1', 'Road planner', 'AI_CHAT', 'd-2'),
  { id: 'u-1', label: 'Road Runner', type: 'user', data: {}, description: 'User (cross-drive)' },
];

const ALPHA_ROAD = 'GET /api/mentions/search?q=road&types=page&driveId=d-1';
const HOME_ROAD = 'GET /api/mentions/search?q=road&types=page&driveId=home-1';
const ALL_ROAD = 'GET /api/mentions/search?q=road&types=page&crossDrive=true';

const answer =
  (body: unknown): FakeRoute =>
  () =>
    Response.json(body);

const setup = (pathname = '/d-1/files', routes: Record<string, FakeRoute> = {}) => {
  const web = fakeWeb({ [ALPHA_ROAD]: answer(inAlpha), [HOME_ROAD]: answer([]), [ALL_ROAD]: answer(everywhere), ...routes });
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <textarea aria-label="Message Imago" />
      <CommandPalette stage={stageFor(pathname)} homeDriveId="home-1" drives={drives} delayMs={1} />
    </ImagoSWRProvider>,
  );
  const composer = container.querySelector('textarea') as HTMLTextAreaElement;
  return { web, container, composer };
};

const dialog = (container: HTMLElement) => container.querySelector('[role="dialog"]');
const field = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[role="combobox"]');
const options = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="option"]')].map((option) => ({
    text: option.textContent,
    selected: option.getAttribute('aria-selected'),
  }));
const ctrlK = (target: Element) => {
  const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
};
/** Polls until `check` passes, letting React render what arrived between polls. */
const settle = (check: () => void): Promise<void> =>
  vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { timeout: 1000, interval: 5 },
  );
const listed = (container: HTMLElement, count: number) =>
  settle(() => {
    if (options(container).length !== count) throw new Error(`not ${count} results`);
  });

beforeEach(() => {
  setUiState(createInitialState());
  router.pushed = [];
});

afterEach(() => {
  unmountAll();
});

describe('CommandPalette', () => {
  test('keyboard only: open, search, move and select', async () => {
    const { web, container, composer } = setup();
    composer.focus();
    const closedBefore = dialog(container) === null;
    const prevented = ctrlK(composer);
    const focusedField = document.activeElement === field(container);
    typeInto(field(container) as HTMLInputElement, 'road');
    await listed(container, 3);
    const first = options(container);
    press(field(container) as HTMLInputElement, 'ArrowDown');
    const second = options(container).map((option) => option.selected);
    press(field(container) as HTMLInputElement, 'Enter');

    assert({
      given: 'Ctrl-K in the composer, "road" typed, ↓ and Enter, with no pointer',
      should:
        'open over the frame with the field focused, list the drive’s matches with the first highlighted, move to the second, open that channel in Messages, close and give focus back to the composer',
      actual: {
        closedBefore,
        prevented,
        focusedField,
        asked: web.requests.map((request) => request.url),
        first,
        second,
        pushed: router.pushed,
        closed: dialog(container) === null,
        focusBack: document.activeElement === composer,
      },
      expected: {
        closedBefore: true,
        prevented: true,
        focusedField: true,
        asked: ['/api/mentions/search?q=road&types=page&driveId=d-1'],
        first: [
          { text: 'Roadmap', selected: 'true' },
          { text: 'road-crew', selected: 'false' },
          { text: 'Road tasks', selected: 'false' },
        ],
        second: ['false', 'true', 'false'],
        pushed: ['/d-1/messages/p-2'],
        closed: true,
        focusBack: true,
      },
    });
  });

  test('wrapping and the task list', async () => {
    const { container } = setup();
    ctrlK(document.body);
    typeInto(field(container) as HTMLInputElement, 'road');
    await listed(container, 3);
    press(field(container) as HTMLInputElement, 'ArrowUp');
    const wrapped = options(container).map((option) => option.selected);
    press(field(container) as HTMLInputElement, 'Enter');

    assert({
      given: '↑ from the first result, then Enter',
      should: 'wrap to the last result and open the task list in Tasks',
      actual: [wrapped, router.pushed],
      expected: [['false', 'false', 'true'], ['/d-1/tasks/p-3']],
    });
  });

  test('a document', async () => {
    const { container } = setup();
    ctrlK(document.body);
    typeInto(field(container) as HTMLInputElement, 'road');
    await listed(container, 3);
    press(field(container) as HTMLInputElement, 'Enter');

    assert({
      given: 'Enter on the first result, a document',
      should: 'open it in Files',
      actual: router.pushed,
      expected: ['/d-1/files/p-1'],
    });
  });

  test('include all workspaces', async () => {
    const { web, container } = setup();
    ctrlK(document.body);
    typeInto(field(container) as HTMLInputElement, 'road');
    await listed(container, 3);
    const toggle = container.querySelector<HTMLButtonElement>('[role="checkbox"]') as HTMLButtonElement;
    click(toggle);
    await settle(() => {
      if (!options(container).some((option) => option.text?.includes('Road planner'))) throw new Error('not every drive');
    });
    const rows = options(container).map((option) => option.text);
    const placeholder = field(container)?.placeholder;
    press(field(container) as HTMLInputElement, 'ArrowDown');
    press(field(container) as HTMLInputElement, 'Enter');

    assert({
      given: '"Include all workspaces" ticked with "road" typed, then the agent picked',
      should:
        'ask every drive, list only the pages the server answered with each one’s drive, and open the agent’s drive chat talking to it',
      actual: {
        ticked: toggle.getAttribute('aria-checked'),
        asked: web.requests.map((request) => request.url),
        rows,
        placeholder,
        pushed: router.pushed,
        agent: getUiState().resources.chatAgent,
      },
      expected: {
        ticked: 'true',
        asked: [
          '/api/mentions/search?q=road&types=page&driveId=d-1',
          '/api/mentions/search?q=road&types=page&crossDrive=true',
        ],
        rows: ['RoadmapAlpha', 'Road plannerBeta'],
        placeholder: 'Search all workspaces…',
        pushed: ['/d-2'],
        agent: { id: 'a-1', title: 'Road planner' },
      },
    });
  });

  test('a stage with no drive', async () => {
    const { web, container } = setup('/dm');
    ctrlK(document.body);
    const placeholder = field(container)?.placeholder;
    typeInto(field(container) as HTMLInputElement, 'road');
    await settle(() => {
      if (!container.textContent?.includes('No matches')) throw new Error('not answered');
    });

    assert({
      given: 'the palette opened from the DMs, which name no drive',
      should: 'search the viewer’s Home drive and say nothing matched',
      actual: [placeholder, web.requests.map((request) => request.url)],
      expected: ['Search Home…', ['/api/mentions/search?q=road&types=page&driveId=home-1']],
    });
  });

  test('a failed search', async () => {
    const { container } = setup('/d-1', {
      [ALPHA_ROAD]: () => Response.json({ error: 'Internal Server Error' }, { status: 500 }),
    });
    ctrlK(document.body);
    typeInto(field(container) as HTMLInputElement, 'road');
    await settle(() => {
      if (!container.textContent?.includes('Search failed')) throw new Error('no failure');
    });
    press(field(container) as HTMLInputElement, 'Enter');

    assert({
      given: 'the search failing',
      should: 'say so, list nothing, and do nothing on Enter',
      actual: [options(container).length, router.pushed, dialog(container) === null],
      expected: [0, [], false],
    });
  });

  test('closing', async () => {
    const { container, composer } = setup();
    composer.focus();
    ctrlK(composer);
    typeInto(field(container) as HTMLInputElement, 'road');
    press(field(container) as HTMLInputElement, 'Escape');
    const afterEscape = [dialog(container) === null, document.activeElement === composer];
    composer.focus();
    ctrlK(composer);
    const reopenedEmpty = field(container)?.value;
    ctrlK(field(container) as HTMLInputElement);
    const afterToggle = [dialog(container) === null, document.activeElement === composer];
    ctrlK(composer);
    act(() => {
      (container.querySelector('[data-palette]') as HTMLElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });

    assert({
      given: 'Escape, Ctrl-K again while open, and a press outside the sheet',
      should: 'close each time, give focus back to the composer, and reopen with an empty field',
      actual: [afterEscape, reopenedEmpty, afterToggle, dialog(container) === null, router.pushed],
      expected: [[true, true], '', [true, true], true, []],
    });
  });

  test('focus stays in the palette', () => {
    const { container } = setup();
    ctrlK(document.body);
    const input = field(container) as HTMLInputElement;
    const toggle = container.querySelector<HTMLButtonElement>('[role="checkbox"]') as HTMLButtonElement;
    const tabbed = press(input, 'Tab');
    toggle.focus();
    const wrapped = press(toggle, 'Tab');
    const onField = document.activeElement === input;
    const back = press(input, 'Tab');
    const shiftWrapped = (() => {
      input.focus();
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
      act(() => {
        input.dispatchEvent(event);
      });
      return [event.defaultPrevented, document.activeElement === toggle];
    })();

    assert({
      given: 'Tab from the field, Tab from the toggle, and Shift-Tab from the field',
      should: 'let the browser move to the toggle, wrap back to the field, and wrap back to the toggle',
      actual: [tabbed, wrapped, onField, back, shiftWrapped],
      expected: [false, true, true, false, [true, true]],
    });
  });

  test('the pointer', async () => {
    const { container } = setup();
    ctrlK(document.body);
    typeInto(field(container) as HTMLInputElement, 'road');
    await listed(container, 3);
    const rows = container.querySelectorAll<HTMLElement>('[role="option"]');
    act(() => {
      rows[2]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    const hovered = options(container).map((option) => option.selected);
    click(rows[1] as HTMLElement);

    assert({
      given: 'the pointer over the third result, then a click on the second',
      should: 'highlight the third, then open the second',
      actual: [hovered, router.pushed],
      expected: [['false', 'false', 'true'], ['/d-1/messages/p-2']],
    });
  });

  test('other shortcuts', () => {
    const { container, composer } = setup();
    const keys = [
      { key: 'k' },
      { key: 'k', metaKey: true },
      { key: 'Enter' },
      { key: 'k', ctrlKey: true, altKey: true },
    ].map((init) => {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      act(() => {
        composer.dispatchEvent(event);
      });
      return event.defaultPrevented;
    });

    assert({
      given: 'K, ⌘K off a Mac, Enter and Ctrl-Alt-K in the composer',
      should: 'leave each to the composer and keep the palette closed',
      actual: [keys, dialog(container) === null],
      expected: [[false, false, false, false], true],
    });
  });
});
