import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

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

type Page = () => Promise<ReactNode>;

/** Every stage route below the shell, and what it renders into the object slot. */
const routes: readonly { readonly path: string; readonly load: () => Promise<{ default: Page }>; readonly object: string | null }[] = [
  { path: '[driveId]', load: () => import('./[driveId]/page'), object: null },
  { path: '[driveId]/files', load: () => import('./[driveId]/files/page'), object: null },
  { path: '[driveId]/files/[pageId]', load: () => import('./[driveId]/files/[pageId]/page'), object: 'Page' },
  { path: '[driveId]/messages', load: () => import('./[driveId]/messages/page'), object: null },
  { path: '[driveId]/messages/[pageId]', load: () => import('./[driveId]/messages/[pageId]/page'), object: 'Channel' },
  { path: '[driveId]/tasks', load: () => import('./[driveId]/tasks/page'), object: null },
  { path: '[driveId]/tasks/[pageId]', load: () => import('./[driveId]/tasks/[pageId]/page'), object: 'Task list' },
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
      expected: ['page.tsx', ...routes.map((route) => `(shell)/${route.path}/page.tsx`)].sort(),
    });
  });

  test('pages render only object content', async () => {
    getViewer.mockResolvedValue(viewer);
    const rendered = await Promise.all(
      routes.map(async (route) => {
        const { default: Page } = await route.load();
        const element = await Page();
        return element === null ? null : renderToStaticMarkup(element);
      }),
    );

    assert({
      given: 'each stage route for a signed-in viewer',
      should: 'render nothing for the stages with no object and only the object’s placeholder otherwise',
      actual: rendered,
      expected: routes.map((route) =>
        route.object === null ? null : `<div class="p-4 text-ink-muted" data-object-placeholder="">${route.object}</div>`,
      ),
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
        return Page().then(
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
