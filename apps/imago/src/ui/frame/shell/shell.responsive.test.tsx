// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import type { Stage } from '../stage/stage';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { fakeRealtime } from '../../test-support/fake-realtime';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The URL is the shell's only input besides the store. Next's router is the
// seam: a navigation is a new pathname with the same layout still mounted.
const navigation = vi.hoisted(() => ({ pathname: '/drive-1' as string | null, search: '' }));
vi.mock('@/retained-adapters/retained-provider', () => ({ RetainedSurface: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/retained/components/auth/OrgReauthenticationPrompt', () => ({ OrgReauthenticationPrompt: () => null }));
vi.mock('@/retained/components/orgs/OrgSurfaceBanner', () => ({ OrgSurfaceBanner: () => null }));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  // The palette navigates through the router; its own suite proves where.
  useRouter: () => ({ push: () => {} }),
}));
// The avatar menu's theme switcher needs the root layout's theme provider;
// its own suites prove it. Here it only has to be in the menu.
vi.mock('@/ui/components/theme-switcher/theme-switcher', () => ({
  ThemeSwitcher: () => h('div', { role: 'radiogroup', 'aria-label': 'Theme' }),
}));

// The drive switcher is apps/web's dialog on the retained stores; its own suite
// (and the brand chip's) proves it. Here it only has to open from the tile.
vi.mock('@/retained/components/layout/navbar/DriveSwitcherDialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? h('div', { role: 'dialog', 'aria-label': 'Switch drive' }) : null),
}));

// The messages pane loads through SWR and realtime; its own suite proves it
// against the real hooks. Here it only shows what the shell handed it.
vi.mock('@/ui/messages/messages-pane/messages-pane', () => ({
  MessagesPane: ({
    driveId,
    selectedPageId,
    selectedConversationId,
  }: {
    driveId: string | null;
    selectedPageId: string | null;
    selectedConversationId: string | null;
  }) =>
    h('div', {
      'data-messages-pane': driveId ?? '',
      'data-page': selectedPageId ?? '',
      'data-conversation': selectedConversationId ?? '',
    }),
}));

// The DM index pane loads through SWR and realtime too; its own suite proves
// it against the real hooks. Here it shows the open conversation it was handed.
vi.mock('@/ui/messages/dm-index/dm-index', () => ({
  DmIndexPane: ({ selectedConversationId }: { selectedConversationId: string | null }) =>
    h('div', { 'data-dm-pane': '', 'data-conversation': selectedConversationId ?? '' }),
}));

// The tasks pane loads through SWR; its own suite proves it against the real
// client. Here it only shows what the shell handed it.
vi.mock('@/ui/tasks/tasks-pane/tasks-pane', () => ({
  TasksPane: ({ driveId, selectedPageId }: { driveId: string; selectedPageId: string | null }) =>
    h('div', { 'data-tasks-pane': driveId, 'data-selected': selectedPageId ?? '' }),
}));

// The files pane loads its tree through SWR and realtime; its own suite
// proves it against the real hooks. Here it draws the real list pane (so
// Close sidebar behaves as in the app) around what the shell handed it.
vi.mock('@/ui/files/files-pane/files-pane', async () => {
  const { ListPane } = await import('@/ui/frame/list-pane/list-pane');
  return {
    FilesPane: ({
      driveId,
      selectedPageId,
      variant,
      title,
      phoneHeader,
    }: {
      driveId: string;
      selectedPageId: string | null;
      variant: 'list' | 'tree';
      title: string;
      phoneHeader?: (newPage: ReactNode) => ReactNode;
    }) =>
      phoneHeader === undefined
        ? h(
            ListPane,
            { section: 'files', variant, title },
            h('div', { 'data-files-pane': driveId, 'data-selected': selectedPageId ?? '' }),
          )
        : h(
            'section',
            { 'aria-label': title, 'data-phone-files': driveId },
            phoneHeader(h('button', { type: 'button', 'aria-label': 'New page' })),
          ),
  };
});

// The chat pane loads agents, conversations and turns through SWR; its own
// suite proves it against the real hooks. Here it shows what the shell handed
// it (the head's leading and trailing controls), the context the stage gives
// it, and how often it mounted.
const chatMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/ui/chat/chat-pane/chat-pane', async () => {
  const { useState } = await import('react');
  const { chatContextFor } = await import('../stage/stage');
  const { renderPaneHeader } = await import('../pane/pane-header');
  return {
    ChatPane: ({
      stage,
      driveName,
      homeDriveId,
      leading,
      trailing,
    }: {
      stage: Stage;
      driveName?: string;
      homeDriveId: string | null;
      leading?: ReactNode;
      trailing?: ReactNode;
    }) => {
      useState(() => {
        chatMounts.count += 1;
        return chatMounts.count;
      });
      const context = chatContextFor(stage, driveName === undefined ? {} : { drive: driveName });
      return h(
        'aside',
        { 'aria-label': 'Imago', 'data-density': context.density, 'data-drive': stage.driveId ?? '', 'data-home': homeDriveId ?? '' },
        renderPaneHeader({ title: 'Imago', leading, actions: trailing }),
        context.contextLabel,
      );
    },
  };
});

// The page head loads the page, its trail and classic's share and presence; its own suite
// proves them. Here it only has to carry the shell's Show sidebar, Ask and Close page.
vi.mock('@/ui/files/page-head/page-head', async () => {
  const { renderPaneHeader } = await import('../pane/pane-header');
  return {
    PageHead: ({ pageId, leading, trailing }: { pageId: string; leading?: ReactNode; trailing?: ReactNode }) =>
      renderPaneHeader({ title: `page ${pageId}`, leading, actions: trailing }),
  };
});

// The phone page head and Back load the page, its trail and the drive's tabs; their own suite proves them.
vi.mock('@/ui/frame/phone/phone-doc-head', () => ({
  PhoneDocHead: ({ pageId }: { pageId: string }) => h('header', { 'data-phone-head': pageId }, h('a', { 'aria-label': 'Back to Pages', href: '/' })),
}));
vi.mock('@/ui/frame/phone/phone-chat-back', () => ({
  PhoneChatBack: ({ onBack }: { onBack: () => void }) => h('button', { type: 'button', 'aria-label': 'Back to Q4 Launch Plan', onClick: onBack }),
}));

// The chat history loads through SWR; its own suite proves it beside the real
// chat pane. Here it only has to be in the list slot, with its Close sidebar
// wired to the store as the real one is.
const historyMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/ui/chat/chat-history/chat-history', async () => {
  const { useState } = await import('react');
  const { dispatch, transactions } = await import('../../store/transactions');
  return {
    ChatHistory: () => {
      useState(() => {
        historyMounts.count += 1;
        return historyMounts.count;
      });
      return h(
        'section',
        { 'aria-label': 'Chat history' },
        h('button', { type: 'button', 'aria-label': 'Close sidebar', onClick: () => dispatch(transactions.collapseSection, 'chat') }),
      );
    },
  };
});

// A drive tool's pane loads its own data; its suites prove it. Here it only has to be in the list slot.
vi.mock('@/ui/frame/tool-pane/tool-pane', () => ({
  ToolPane: ({ tool, driveId }: { tool: string; driveId: string }) => h('div', { 'data-tool-pane': `${tool}:${driveId}` }),
}));

const { Shell } = await import('./shell');

let root: Root | null = null;
let container: HTMLElement;
const realtime = fakeRealtime();

const initialDrives = [
  { id: 'home-1', name: 'Home', kind: 'HOME' as const },
  { id: 'drive-1', name: 'Alpha', kind: 'STANDARD' as const },
];

/** A window of the given width: matchMedia answers the tier queries from it. */
const setWidth = (width: number) => {
  window.matchMedia = ((query: string) => {
    const max = Number(/max-width: ([\d.]+)px/.exec(query)?.[1]);
    return {
      matches: width <= max,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
};

const render = (pathname: string) => {
  navigation.pathname = pathname;
  act(() => {
    root?.render(
      h(RealtimeProvider, {
        client: realtime.client,
        children: h(Shell, { homeDriveId: 'home-1', initialDrives, children: h('p', { 'data-route': '' }, 'route') }),
      }),
    );
  });
};

const slot = (name: string): HTMLElement => {
  const element = container.querySelector(`[data-slot="${name}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${name} slot`);
  return element;
};

const byLabel = (label: string): HTMLElement | null => container.querySelector(`[aria-label="${label}"]`);

const press = (label: string) => {
  const element = byLabel(label);
  if (element === null) throw new Error(`no ${label}`);
  act(() => element.click());
};

beforeEach(() => {
  setUiState(createInitialState());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  // @ts-expect-error the jsdom default has no matchMedia
  delete window.matchMedia;
});

describe('Shell at 1024 to 1279 (C-Resp-Tablet-Doc)', () => {
  beforeEach(() => setWidth(1100));

  test('the pane stays docked at 236px and Imago is a 340px sheet with a scrim', () => {
    render('/drive-1/files/page-1');
    assert({
      given: 'a page open at 1100px',
      should: 'dock the pane at 236px, make Imago a 340px right sheet and offer the scrim and Collapse Imago',
      actual: [
        container.firstElementChild?.getAttribute('data-tier'),
        container.firstElementChild?.getAttribute('data-imago'),
        slot('list').className.includes('w-pane-overlay'),
        slot('chat').className.includes('w-chat-overlay'),
        slot('chat').className.includes('absolute'),
        byLabel('Dismiss Imago overlay') !== null,
        byLabel('Collapse Imago') !== null,
      ],
      expected: ['overlay', 'overlay', true, true, true, true, true],
    });
  });

  test('the scrim and Collapse Imago close the sheet and the Ask pill reopens it', () => {
    render('/drive-1/files/page-1');
    press('Dismiss Imago overlay');
    const afterScrim = [getUiState().resources.imagoCollapsed, byLabel('Dismiss Imago overlay'), slot('chat').className.includes('w-0')];
    const ask = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Ask');
    if (ask === undefined) throw new Error('no Ask pill');
    act(() => ask.click());
    const reopened = [getUiState().resources.imagoCollapsed, byLabel('Dismiss Imago overlay') !== null];
    press('Collapse Imago');
    assert({
      given: 'the scrim pressed, then Ask, then Collapse Imago',
      should: 'collapse Imago to the Ask pill, reopen the sheet, and collapse it again',
      actual: [afterScrim, reopened, getUiState().resources.imagoCollapsed],
      expected: [[true, null, true], [false, true], true],
    });
  });

  test('with the page closed Imago is the full-width ground, and closing it leaves the empty middle', () => {
    render('/drive-1/files');
    const ground = [slot('chat').className.includes('flex-1'), byLabel('Dismiss Imago overlay'), byLabel('Close Imago') !== null];
    press('Close Imago');
    assert({
      given: 'the Files index at 1100px, then Close Imago',
      should: 'fill the middle with Imago and no scrim, then show the empty middle',
      actual: [ground, container.firstElementChild?.getAttribute('data-imago')],
      expected: [[true, null, true], 'none'],
    });
  });

  test('with the pane closed Show sidebar moves into the first head', () => {
    render('/drive-1/files/page-1');
    press('Close sidebar');
    assert({
      given: 'the pane closed beside a page',
      should: 'close the pane slot and offer Show sidebar',
      actual: [slot('list').className.includes('w-0'), byLabel('Show sidebar') !== null],
      expected: [true, true],
    });
  });
});

describe('Shell at 600 to 1023', () => {
  beforeEach(() => setWidth(800));

  test('the pane is a left sheet, shut until Show sidebar, and Imago stays an overlay', () => {
    render('/drive-1/files/page-1');
    const first = [byLabel('Dismiss sidebar'), byLabel('Show sidebar') !== null, container.firstElementChild?.getAttribute('data-imago')];
    press('Show sidebar');
    const opened = [slot('list').className.includes('absolute'), byLabel('Dismiss sidebar') !== null];
    press('Dismiss sidebar');
    assert({
      given: 'a page at 800px',
      should: 'start with the pane sheet shut, open it over the page from Show sidebar, and close it from its scrim',
      actual: [first, opened, byLabel('Dismiss sidebar'), byLabel('Show sidebar') !== null],
      expected: [[null, true, 'overlay'], [true, true], null, true],
    });
  });
});

describe('Shell on a phone (C-Resp-Phone-Tree)', () => {
  beforeEach(() => setWidth(390));

  test('one column: no spine, no tab bar, and the bottom bar names the active section', () => {
    render('/drive-1/files');
    const bar = container.querySelector('nav[data-slot="phone-bar"]');
    assert({
      given: 'the Files section at 390px',
      should: 'show one nav "Sections" (the bottom bar) with Files current, and no rail',
      actual: [
        container.querySelectorAll('nav[aria-label="Sections"]').length,
        container.querySelector('[data-slot="rail"]'),
        bar?.querySelector('[aria-current="page"]')?.getAttribute('aria-label'),
        container.querySelector('[data-slot="chat"]'),
      ],
      expected: [1, null, 'Pages', null],
    });
  });

  test('the Files tree fills the screen under the phone head, with a floating Ask', () => {
    render('/drive-1/files');
    assert({
      given: 'the Files section at 390px',
      should: 'render the full-screen pane with the drive switcher, Search, Notifications, New page and an Ask link to the chat',
      actual: [
        container.querySelector('[data-phone-files]')?.getAttribute('data-phone-files'),
        byLabel('Switch drive: Alpha') !== null,
        byLabel('Search') !== null,
        byLabel('Notifications') !== null,
        byLabel('New page') !== null,
        Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'Ask')?.getAttribute('href'),
      ],
      expected: ['drive-1', true, true, true, true, '/drive-1'],
    });
  });

  test('a tapped row opens its page full-screen', () => {
    render('/drive-1/files/page-1');
    assert({
      given: 'a page address at 390px',
      should: 'show the page screen and no Files pane',
      actual: [container.querySelector('[data-route]') !== null, container.querySelector('[data-phone-files]'), byLabel('page page-1') === null],
      expected: [true, null, true],
    });
  });

  test('a page shows its phone head, the bottom bar and a floating Ask button', () => {
    render('/drive-1/files/page-1');
    assert({
      given: 'a page at 390px',
      should: 'draw the phone page head, the bottom bar and Ask, and no Imago',
      actual: [
        container.querySelector('[data-phone-head]')?.getAttribute('data-phone-head'),
        container.querySelector('nav[data-slot="phone-bar"]') !== null,
        Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Ask'),
        byLabel('Imago'),
      ],
      expected: ['page-1', true, true, null],
    });
  });

  test('Ask opens Imago full-screen with Back and no bottom bar; Back returns to the page', () => {
    render('/drive-1/files/page-1');
    act(() => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Ask')?.click());
    assert({
      given: 'Ask pressed on a phone page',
      should: 'show Imago with Back to the page, hide the bottom bar, the page and Ask',
      actual: [
        byLabel('Imago') !== null,
        byLabel('Back to Q4 Launch Plan') !== null,
        container.querySelector('nav[data-slot="phone-bar"]'),
        container.querySelector('[data-route]'),
        Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Ask'),
      ],
      expected: [true, true, null, null, false],
    });
    press('Back to Q4 Launch Plan');
    assert({
      given: 'Back pressed',
      should: 'return to the page with the bottom bar visible',
      actual: [byLabel('Imago'), container.querySelector('[data-route]') !== null, container.querySelector('nav[data-slot="phone-bar"]') !== null],
      expected: [null, true, true],
    });
  });

  test('leaving the page ends its full-screen Imago', () => {
    render('/drive-1/files/page-1');
    act(() => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Ask')?.click());
    render('/drive-1/files/page-2');
    assert({
      given: 'a navigation to another page while asking',
      should: 'show that page, not the chat',
      actual: [byLabel('Imago'), container.querySelector('[data-route]') !== null],
      expected: [null, true],
    });
  });

  test('Search opens the palette from the head', () => {
    render('/drive-1/files');
    press('Search');
    assert({ given: 'Search pressed on a phone', should: 'open the palette', actual: getUiState().resources.paletteOpen, expected: true });
  });

  test('More opens the account menu', () => {
    render('/drive-1/files');
    const more = container.querySelector('summary[aria-label^="More"]');
    if (!(more instanceof HTMLElement)) throw new Error('no More');
    assert({
      given: 'the bottom bar',
      should: 'carry More as the account menu trigger',
      actual: [more.closest('details')?.querySelector('ul')?.getAttribute('aria-label'), more.closest('nav')?.getAttribute('aria-label')],
      expected: ['Account', 'Sections'],
    });
  });

  test('a conversation or chat section also gets the bottom bar', () => {
    render('/drive-1');
    assert({
      given: 'the chat section at 390px',
      should: 'show Imago as the screen with the bar',
      actual: [byLabel('Imago') !== null, container.querySelector('nav[data-slot="phone-bar"]') !== null],
      expected: [true, true],
    });
  });
});

describe('Shell resize seams (classic resizable panels)', () => {
  const seams = () => Array.from(container.querySelectorAll('[role="separator"]')).map((seam) => seam.getAttribute('aria-label'));

  test('desktop: the docked pane and docked Imago each carry a seam', () => {
    setWidth(1440);
    render('/drive-1/files/page-1');
    assert({
      given: 'a page open at 1440px',
      should: 'offer a seam on the tree and one on Imago',
      actual: seams(),
      expected: ['Resize sidebar', 'Resize Imago'],
    });
  });

  test('Imago on the ground has no seam of its own', () => {
    setWidth(1440);
    render('/drive-1/files');
    assert({
      given: 'the Files index at 1440px',
      should: 'offer only the sidebar seam',
      actual: seams(),
      expected: ['Resize sidebar'],
    });
  });

  test('1024 to 1279: the docked pane resizes, the Imago sheet does not', () => {
    setWidth(1100);
    render('/drive-1/files/page-1');
    assert({ given: 'a page open at 1100px', should: 'offer only the sidebar seam', actual: seams(), expected: ['Resize sidebar'] });
  });

  test('sheets and the phone never resize', () => {
    setWidth(800);
    render('/drive-1/files/page-1');
    const narrow = seams();
    act(() => root?.unmount());
    root = createRoot(container);
    setWidth(390);
    render('/drive-1/files/page-1');
    assert({ given: 'the narrow tier, then a phone', should: 'offer no seams', actual: [narrow, seams()], expected: [[], []] });
  });

  test('a collapsed pane loses its seam', () => {
    setWidth(1440);
    render('/drive-1/files/page-1');
    press('Close sidebar');
    assert({ given: 'Close sidebar on the tree', should: 'leave only the Imago seam', actual: seams(), expected: ['Resize Imago'] });
  });

  test('a keyed resize sets the pane width and persists it', () => {
    setWidth(1440);
    localStorage.removeItem('imago:pane-sizes');
    render('/drive-1/files/page-1');
    const seam = container.querySelector('[aria-label="Resize Imago"]');
    if (!(seam instanceof HTMLElement)) throw new Error('no seam');
    act(() => {
      seam.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    const after = [slot('chat').style.width, localStorage.getItem('imago:pane-sizes')];
    const reset = container.querySelector('[aria-label="Resize Imago"]');
    if (!(reset instanceof HTMLElement)) throw new Error('no seam');
    act(() => {
      reset.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    assert({
      given: 'Home on the Imago seam, then a double-click',
      should: 'pin Imago to its minimum and store it, then put the token width back',
      actual: [after, slot('chat').style.width],
      expected: [['300px', '{"left":null,"imago":300}'], ''],
    });
  });

  test('saved widths that no longer fit give way to the middle, and the saved pair is kept', () => {
    setWidth(1440);
    localStorage.setItem('imago:pane-sizes', '{"left":480,"imago":720}');
    // The columns row reports 1000px: 480 + 720 would leave the page nothing.
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([{ contentRect: { width: 1000 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      render('/drive-1/files/page-1');
      assert({
        given: 'a 480px pane and 720px Imago saved, in a 1000px row',
        should: 'draw both at their minimums so the page keeps 400px, without rewriting what was saved',
        actual: [slot('list').style.width, slot('chat').style.width, localStorage.getItem('imago:pane-sizes')],
        expected: ['300px', '300px', '{"left":480,"imago":720}'],
      });
    } finally {
      globalThis.ResizeObserver = original;
      localStorage.removeItem('imago:pane-sizes');
    }
  });
});
