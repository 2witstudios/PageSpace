import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode, ReactElement } from 'react';
import { ClassicHandoff } from '@/ui/files/classic-handoff/classic-handoff';
import { FileObject } from '@/ui/files/file-object/file-object';
import { PageObject } from '@/ui/files/page-object/page-object';

// getViewer() itself is proven against Postgres in
// lib/auth/get-viewer.integration.test.ts; here it is every route's seam.
const getViewer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/get-viewer', () => ({ getViewer }));
// getHomeDrive() is proven against Postgres with the root page
// (app/page.integration.test.ts); here the layout only passes its id on.
const getHomeDrive = vi.hoisted(() => vi.fn());
// listAccessibleDrives() is the same service apps/web's GET /api/drives
// answers with; here the layout only hands its rows to the shell.
const listAccessibleDrives = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/services/drive-service', () => ({ getHomeDrive, listAccessibleDrives }));
// getUserDriveAccess() is the centralized drive access check
// (packages/lib/src/permissions); here it is the drive gate's seam.
const getUserDriveAccess = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/permissions/permissions', () => ({ getUserDriveAccess }));

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
  { path: '[driveId]/files/[pageId]', load: () => import('./[driveId]/files/[pageId]/page'), object: 'page-object' },
  { path: '[driveId]/messages', load: () => import('./[driveId]/messages/page'), object: null },
  { path: '[driveId]/messages/[pageId]', load: () => import('./[driveId]/messages/[pageId]/page'), object: 'channel-thread' },
  { path: '[driveId]/tasks', load: () => import('./[driveId]/tasks/page'), object: null },
  { path: '[driveId]/settings', load: () => import('./[driveId]/settings/page'), object: 'drive-settings' },
  { path: 'dm', load: () => import('./dm/page'), object: null },
  { path: 'dm/[conversationId]', load: () => import('./dm/[conversationId]/page'), object: 'conversation-object' },
  { path: 'account', load: () => import('./account/page'), object: 'account' },
];


const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

/** Rows as listAccessibleDrives returns them (DriveWithAccess). */
const driveRow = (id: string, name: string, kind: 'HOME' | 'STANDARD') => ({
  id,
  name,
  slug: name.toLowerCase(),
  ownerId: 'user-1',
  kind,
  isTrashed: false,
  trashedAt: null,
  drivePrompt: 'secret prompt',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isOwned: true,
  role: 'OWNER',
  canCreatePages: true,
  lastAccessedAt: null,
  homePageId: null,
});

const loadTaskPage = () => import('./[driveId]/tasks/[pageId]/page');

// The first import of the layout pulls in the whole Shell tree (and each
// route its own): ~0.5s locally, past vitest's 5s test timeout on a loaded
// CI runner. Pay that once here so each test times only its own render.
const WARM_UP_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  await Promise.all([
    import('./layout'),
    import('./[driveId]/layout'),
    import('@/ui/frame/shell/shell'),
    import('@/ui/tasks/task-object/task-object'),
    loadTaskPage(),
    ...routes.map((route) => route.load()),
  ]);
}, WARM_UP_TIMEOUT_MS);

beforeEach(() => {
  getViewer.mockReset();
  getHomeDrive.mockReset();
  getHomeDrive.mockResolvedValue({ id: 'home-1', kind: 'HOME', ownerId: 'user-1' });
  listAccessibleDrives.mockReset();
  listAccessibleDrives.mockResolvedValue([driveRow('d-alpha', 'Alpha', 'STANDARD'), driveRow('home-1', 'Home', 'HOME')]);
  getUserDriveAccess.mockReset();
});

describe('the (shell) layout', () => {
  test('mounts the shell behind the auth gate', async () => {
    getViewer.mockResolvedValue(viewer);
    const { default: ShellLayout } = await import('./layout');
    const provider = await ShellLayout({ children: 'route' });
    const element = provider.props.children;
    const { Shell } = await import('@/ui/frame/shell/shell');

    assert({
      given: 'a signed-in viewer',
      should: 'resolve the viewer, their Home drive and their drives, then render the one Shell around the route',
      actual: [
        getViewer.mock.calls.length,
        getHomeDrive.mock.calls,
        listAccessibleDrives.mock.calls,
        element.type === Shell,
        element.props.homeDriveId,
        element.props.children,
      ],
      expected: [1, [['user-1']], [['user-1']], true, 'home-1', 'route'],
    });

    assert({
      given: 'the viewer’s drive rows',
      should: 'hand the shell only each drive’s id, name and kind',
      actual: element.props.initialDrives,
      expected: [
        { id: 'd-alpha', name: 'Alpha', kind: 'STANDARD' },
        { id: 'home-1', name: 'Home', kind: 'HOME' },
      ],
    });
  });

  test('a viewer without a Home drive yet', async () => {
    getViewer.mockResolvedValue(viewer);
    getHomeDrive.mockResolvedValue(null);
    const { default: ShellLayout } = await import('./layout');
    const provider = await ShellLayout({ children: 'route' });
    const element = provider.props.children;

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
      actual: [thrown, getHomeDrive.mock.calls.length, listAccessibleDrives.mock.calls.length],
      expected: [redirect, 0, 0],
    });
  });
});

describe('the drive gate', () => {
  const gate = async (driveId: string) => {
    const { default: DriveLayout } = await import('./[driveId]/layout');
    return DriveLayout({ children: 'route', params: Promise.resolve({ driveId }) });
  };

  test('a drive the viewer can open', async () => {
    getViewer.mockResolvedValue(viewer);
    getUserDriveAccess.mockResolvedValue(true);

    assert({
      given: 'a drive the access check allows',
      should: 'ask about that drive for that viewer and render the route',
      actual: [await gate('d-alpha'), getUserDriveAccess.mock.calls],
      expected: ['route', [['user-1', 'd-alpha']]],
    });
  });

  test('a drive the viewer cannot open', async () => {
    getViewer.mockResolvedValue(viewer);
    getUserDriveAccess.mockResolvedValue(false);
    const element = await gate('d-secret');
    const html = renderToStaticMarkup(element);

    assert({
      given: 'a drive the access check refuses (or one that does not exist)',
      should: 'render the not-found object, with the way back to Home, instead of the route',
      actual: [
        html.includes('data-not-found'),
        html.includes('Drive not found'),
        html.includes('href="/home-1"'),
        html.includes('route'),
        html.includes('d-secret'),
      ],
      expected: [true, true, true, false, false],
    });
  });

  test('no valid session', async () => {
    getViewer.mockRejectedValue(redirect);
    const thrown = await gate('d-alpha').then(
      () => null,
      (error: unknown) => error,
    );

    assert({
      given: 'getViewer() redirecting to sign-in',
      should: 'check no access and let the redirect through',
      actual: [thrown, getUserDriveAccess.mock.calls.length],
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
      actual: pages.filter(path => path !== 'page.tsx' && !path.startsWith('(shell)/')),
      expected: [],
    });
  });

  test('native object routes keep the page gate and omit classic handoffs', async () => {
    getViewer.mockResolvedValue(viewer);
    const { default: FilesPage } = await import('./[driveId]/files/[pageId]/page');
    const element = await FilesPage(props()) as ReactElement<{ children: ReactElement<{ children: ReactElement }> }>;
    assert({ given: 'a files object route', should: 'keep the permission-filtered page gate', actual: element.type === PageObject, expected: true });
    const { default: ChannelPage } = await import('./[driveId]/messages/[pageId]/page');
    const channel = await ChannelPage(props());
    assert({ given: 'a channel object route', should: 'use native dispatch behind the same page gate', actual: channel.type === PageObject, expected: true });
    const fileObject = element.props.children;
    assert({ given: 'the file content slot', should: 'keep folders and native page dispatch, without handoffs', actual: fileObject.type === FileObject && fileObject.props.children.type !== ClassicHandoff, expected: true });
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

describe('an open task list or task', () => {
  test('renders the task object for the viewer', async () => {
    getViewer.mockResolvedValue(viewer);
    const { default: Page } = await loadTaskPage();
    const element = await Page(props());
    const { TaskObject } = await import('@/ui/tasks/task-object/task-object');

    assert({
      given: '/[driveId]/tasks/[pageId] for a signed-in viewer',
      should: 'open the list or task named by the awaited params, saving views under the viewer',
      actual: [
        getViewer.mock.calls.length,
        element !== null && typeof element === 'object' && 'type' in element ? element.type === TaskObject : false,
        element !== null && typeof element === 'object' && 'props' in element ? element.props : null,
      ],
      expected: [1, true, { driveId: 'drive-1', pageId: 'page-1', viewerId: 'user-1' }],
    });
  });

  test('keeps the auth gate', async () => {
    getViewer.mockRejectedValue(redirect);
    const { default: Page } = await loadTaskPage();
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
