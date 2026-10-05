import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import { ChannelThread } from '@/ui/messages/thread-view/channel-thread';

// getViewer() itself is proven against Postgres in
// lib/auth/get-viewer.integration.test.ts; here it is every route's seam.
const getViewer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/get-viewer', () => ({ getViewer }));
// getHomeDrive() is proven against Postgres with the root page
// (app/page.integration.test.ts); here the layout only passes its id on.
const getHomeDrive = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/services/drive-service', () => ({ getHomeDrive }));

const appDir = join(__dirname, '..');
const shellDir = __dirname;

const viewer = { userId: 'user-1', role: 'user', sessionId: 'session-1' };

const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
  digest: 'NEXT_REDIRECT;replace;https://pagespace.ai/auth/signin?next=%2Fimago;307;',
});

type Params = Promise<{ readonly driveId: string; readonly pageId: string; readonly conversationId: string }>;

type Page = (props: { readonly params: Params }) => Promise<ReactNode>;

/** What Next hands a dynamic route: its segments, as a Promise (Next 15). */
const props = () => ({ params: Promise.resolve({ driveId: 'drive-1', pageId: 'page-1', conversationId: 'c-1' }) });

/** Every stage route below the shell, and what it renders into the object slot. */
const routes: readonly { readonly path: string; readonly load: () => Promise<{ default: Page }>; readonly object: string | null }[] = [
  { path: '[driveId]', load: () => import('./[driveId]/page'), object: null },
  { path: '[driveId]/files', load: () => import('./[driveId]/files/page'), object: null },
  { path: '[driveId]/files/[pageId]', load: () => import('./[driveId]/files/[pageId]/page'), object: 'Page' },
  { path: '[driveId]/messages', load: () => import('./[driveId]/messages/page'), object: null },
  { path: '[driveId]/messages/[pageId]', load: () => import('./[driveId]/messages/[pageId]/page'), object: 'channel-thread' },
  { path: '[driveId]/tasks', load: () => import('./[driveId]/tasks/page'), object: null },
  { path: '[driveId]/settings', load: () => import('./[driveId]/settings/page'), object: 'Drive settings' },
  { path: 'dm', load: () => import('./dm/page'), object: null },
  { path: 'dm/[conversationId]', load: () => import('./dm/[conversationId]/page'), object: 'Conversation' },
  { path: 'account', load: () => import('./account/page'), object: 'Account' },
];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

beforeEach(() => {
  getViewer.mockReset();
  getHomeDrive.mockReset();
  getHomeDrive.mockResolvedValue({ id: 'home-1', kind: 'HOME', ownerId: 'user-1' });
});

describe('the (shell) layout', () => {
  test('mounts the shell behind the auth gate', async () => {
    getViewer.mockResolvedValue(viewer);
    const { default: ShellLayout } = await import('./layout');
    const element = await ShellLayout({ children: 'route' });
    const { Shell } = await import('@/ui/frame/shell/shell');

    assert({
      given: 'a signed-in viewer',
      should: 'resolve the viewer and their Home drive, then render the one Shell around the route',
      actual: [
        getViewer.mock.calls.length,
        getHomeDrive.mock.calls,
        element.type === Shell,
        element.props.homeDriveId,
        element.props.children,
      ],
      expected: [1, [['user-1']], true, 'home-1', 'route'],
    });
  });

  test('a viewer without a Home drive yet', async () => {
    getViewer.mockResolvedValue(viewer);
    getHomeDrive.mockResolvedValue(null);
    const { default: ShellLayout } = await import('./layout');
    const element = await ShellLayout({ children: 'route' });

    assert({
      given: 'no Home drive (before the backfill reaches the viewer)',
      should: 'still render the shell, with no Home drive for the rail',
      actual: element.props.homeDriveId,
      expected: null,
    });
  });

  test('no valid session', async () => {
    getViewer.mockRejectedValue(redirect);
    const { default: ShellLayout } = await import('./layout');
    let thrown: unknown;
    try {
      await ShellLayout({ children: 'route' });
    } catch (error) {
      thrown = error;
    }

    assert({
      given: 'getViewer() redirecting to sign-in',
      should: 'render no shell, look up no drive and let the redirect through',
      actual: [thrown, getHomeDrive.mock.calls.length],
      expected: [redirect, 0],
    });
  });
});

describe('the stage routes', () => {
  test('every stage route lives under the one shell', () => {
    const pages = files(appDir)
      .filter((path) => path.endsWith('/page.tsx'))
      .map((path) => relative(appDir, path))
      .sort();

    assert({
      given: 'the app directory',
      should: 'put every page except the bare /imago redirect inside (shell), so no navigation leaves the layout',
      actual: pages,
      expected: ['page.tsx', '(shell)/[driveId]/tasks/[pageId]/page.tsx', ...routes.map((route) => `(shell)/${route.path}/page.tsx`)].sort(),
    });
  });

  test('pages render only object content', async () => {
    getViewer.mockResolvedValue(viewer);
    const rendered = await Promise.all(
      routes.map(async (route) => {
        const { default: Page } = await route.load();
        const element = await Page(props());
        if (route.object === 'channel-thread') {
          const thread = element as ReactElement;
          return [thread.type === ChannelThread, thread.props];
        }
        return element === null ? null : renderToStaticMarkup(element);
      }),
    );

    assert({
      given: 'each stage route for a signed-in viewer',
      should: 'render nothing for the stages with no object, the channel thread for the viewer on a channel, and only the object’s placeholder otherwise',
      actual: rendered,
      expected: routes.map((route) => {
        if (route.object === 'channel-thread') {
          return [true, { driveId: 'drive-1', pageId: 'page-1', viewerId: 'user-1' }];
        }
        return route.object === null ? null : `<div class="p-4 text-ink-muted" data-object-placeholder="">${route.object}</div>`;
      }),
    });

    assert({
      given: 'each stage route',
      should: 'resolve the viewer on every route (a soft navigation renders only the page)',
      actual: getViewer.mock.calls.length,
      expected: routes.length,
    });
  });

  test('every route keeps the auth gate', async () => {
    getViewer.mockRejectedValue(redirect);
    const thrown = await Promise.all(
      routes.map(async (route) => {
        const { default: Page } = await route.load();
        return Page(props()).then(
          () => null,
          (error: unknown) => error,
        );
      }),
    );

    assert({
      given: 'no valid session on each stage route',
      should: 'render nothing and let the sign-in redirect through',
      actual: thrown,
      expected: routes.map(() => redirect),
    });
  });
});

describe('an open task list', () => {
  const load = () => import('./[driveId]/tasks/[pageId]/page');

  test('renders the list for the viewer', async () => {
    getViewer.mockResolvedValue(viewer);
    const { default: Page } = await load();
    const element = await Page(props());
    const { TaskListView } = await import('@/ui/tasks/task-list-view/task-list-view');

    assert({
      given: '/[driveId]/tasks/[pageId] for a signed-in viewer',
      should: 'render the task list named by the awaited params, saving views under the viewer',
      actual: [
        getViewer.mock.calls.length,
        element !== null && typeof element === 'object' && 'type' in element ? element.type === TaskListView : false,
        element !== null && typeof element === 'object' && 'props' in element ? element.props : null,
      ],
      expected: [1, true, { driveId: 'drive-1', pageId: 'page-1', viewerId: 'user-1' }],
    });
  });

  test('keeps the auth gate', async () => {
    getViewer.mockRejectedValue(redirect);
    const { default: Page } = await load();
    const thrown = await Page(props()).then(
      () => null,
      (error: unknown) => error,
    );

    assert({
      given: 'no valid session',
      should: 'render nothing and let the sign-in redirect through',
      actual: thrown,
      expected: redirect,
    });
  });
});

describe('no loading boundary above the shell', () => {
  test('the frame never blanks between routes', () => {
    const boundaries = files(appDir)
      .filter((path) => /\/loading\.(tsx|ts|jsx|js)$/.test(path))
      .map((path) => relative(appDir, path));

    assert({
      given: 'the app directory',
      should: 'have no loading.tsx at the root or the shell group, which would replace the frame with a fallback',
      actual: [boundaries.filter((path) => !path.includes('/') || path.startsWith('(shell)/loading')), existsSync(join(shellDir, 'layout.tsx'))],
      expected: [[], true],
    });
  });
});
