// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useFavorites } from '@/retained/hooks/useFavorites';
import { click, mount, typeInto, unmountAll } from '../../test-support/dom';
import { BrandChip } from './brand-chip';

const web = vi.hoisted(() => ({
  pushed: [] as string[],
  calls: [] as string[],
  drives: [
    { id: 'home-1', name: 'Home', isTrashed: false, lastAccessedAt: null },
    { id: 'd-alpha', name: 'Alpha', isTrashed: false, lastAccessedAt: '2026-10-10T00:00:00.000Z' },
    { id: 'd-beta', name: 'Beta', isTrashed: false, lastAccessedAt: '2026-10-08T00:00:00.000Z' },
  ],
  favorites: [] as { id: string; itemType: string; drive: { id: string; name: string } }[],
}));

// The retained navigation adapter: pick-a-drive pushes the classic grammar,
// which the real adapter rewrites to the imago route (its own suite proves it).
vi.mock('@/retained-adapters/navigation', () => ({
  useRouter: () => ({ push: (href: string) => web.pushed.push(href) }),
  usePathname: () => '/dashboard/d-alpha/tasks',
  useParams: () => ({ driveId: 'd-alpha' }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  return {
    fetchWithAuth: (url: string, init?: { method?: string }) => {
      web.calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/user/favorites') return json({ favorites: web.favorites });
      if (url.startsWith('/api/drives/')) return json({ ok: true });
      return json(web.drives);
    },
    post: (url: string, body: { itemId: string }) => {
      web.calls.push(`POST ${url} ${body.itemId}`);
      web.favorites = [...web.favorites, { id: 'fav-1', itemType: 'drive', drive: { id: body.itemId, name: body.itemId } }];
      return json({ favorite: {} });
    },
    del: (url: string) => {
      web.calls.push(`DELETE ${url}`);
      web.favorites = [];
      return json({ success: true });
    },
  };
});

const drives = [
  { id: 'home-1', name: 'Home', kind: 'HOME' },
  { id: 'd-alpha', name: 'Alpha', kind: 'STANDARD' },
  { id: 'd-beta', name: 'Beta', kind: 'STANDARD' },
] as const;

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const tile = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
const rowOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[cmdk-item][data-drive-id]')].find((item) => item.getAttribute('aria-label')?.startsWith(name));
const starOf = (name: string) => rowOf(name)?.querySelector<HTMLElement>('[data-testid="favorite-toggle"]');

const setup = async () => {
  mount(<BrandChip currentId="d-alpha" drives={drives} />);
  await settle();
};

const open = async () => {
  const button = tile();
  if (button === null) throw new Error('no tile');
  click(button);
  await settle();
};

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
  web.favorites = [];
  useDriveStore.setState({ drives: [], lastFetched: 0 });
  useFavorites.setState({ favorites: [], pageIds: new Set(), driveIds: new Set(), isSynced: false, isLoading: false });
});

afterEach(() => {
  unmountAll();
  web.pushed.length = 0;
  web.calls.length = 0;
});

describe('BrandChip', () => {
  test('the tile opens the Switch drive dialog', async () => {
    await setup();
    const before = dialog();
    await open();
    const panel = dialog();

    assert({
      given: 'the spine drive tile pressed',
      should: 'open the retained drive switcher with its search, Create drive, All drives and drives from /api/drives',
      actual: [
        before,
        panel?.querySelector('input')?.getAttribute('placeholder'),
        panel?.textContent?.includes('Create drive'),
        panel?.textContent?.includes('All drives · 3'),
        panel?.textContent?.includes('Recent'),
        tile()?.getAttribute('aria-expanded'),
        web.calls.includes('GET /api/drives'),
      ],
      expected: [null, 'Search drives…', true, true, true, 'true', true],
    });
  });

  test('typing filters the drives', async () => {
    await setup();
    await open();
    const input = dialog()?.querySelector<HTMLInputElement>('input');
    if (input === undefined || input === null) throw new Error('no search');
    typeInto(input, 'bet');

    assert({
      given: 'the query "bet" typed into the switcher',
      should: 'list only Beta',
      actual: [...document.querySelectorAll('[cmdk-item][data-drive-id]')].map((item) => item.getAttribute('data-drive-id')),
      expected: ['d-beta'],
    });
  });

  test('a row star toggles the favorite', async () => {
    await setup();
    await open();
    const before = starOf('Beta')?.getAttribute('title');
    const star = starOf('Beta');
    if (star === undefined || star === null) throw new Error('no star');
    click(star);
    await settle();
    const after = starOf('Beta')?.getAttribute('title');
    const favorites = [...document.querySelectorAll('[cmdk-group-heading]')].map((heading) => heading.textContent);
    const unstar = starOf('Beta');
    if (unstar === undefined || unstar === null) throw new Error('no star');
    click(unstar);
    await settle();

    assert({
      given: 'Beta, which is not a favorite, starred and then unstarred',
      should: 'add it to Favorites through /api/user/favorites with the label flipping, and remove it again',
      actual: [before, after, favorites.includes('Favorites'), web.calls.filter((call) => call.startsWith('POST') || call.startsWith('DELETE')), starOf('Beta')?.getAttribute('title')],
      expected: ['Add to favorites', 'Remove from favorites', true, ['POST /api/user/favorites d-beta', 'DELETE /api/user/favorites/fav-1'], 'Add to favorites'],
    });
  });

  test('picking a drive goes to that drive in the same section and records the access', async () => {
    await setup();
    await open();
    const beta = rowOf('Beta');
    if (beta === undefined) throw new Error('no row');
    click(beta);
    await settle();

    assert({
      given: 'Beta picked while looking at Alpha’s tasks',
      should: 'navigate to Beta’s tasks (the retained adapter rewrites the classic path to imago) and post the access',
      actual: [web.pushed, web.calls.includes('POST /api/drives/d-beta/access')],
      expected: [['/dashboard/d-beta/tasks'], true],
    });
  });
});
