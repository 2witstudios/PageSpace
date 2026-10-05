import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';

// Request-scoped Next APIs have no request outside a server; the layout's own
// logic (cookie → data-theme) runs for real against these request stand-ins.
const request = vi.hoisted(() => ({ cookie: undefined as string | undefined }));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ connection: async () => undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'theme' && request.cookie !== undefined
        ? { name, value: request.cookie }
        : undefined,
  }),
  headers: async () => new Headers({ 'x-nonce': 'test-nonce' }),
}));
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'font-sans-var' }),
  Geist_Mono: () => ({ variable: 'font-mono-var' }),
}));

const renderHtml = async (cookie: string | undefined): Promise<string> => {
  request.cookie = cookie;
  const { default: RootLayout } = await import('./layout');
  return renderToStaticMarkup(await RootLayout({ children: null }));
};

const dataTheme = (html: string): string | undefined =>
  html.match(/<html[^>]*\sdata-theme="([^"]*)"/)?.[1];

describe('RootLayout theme', () => {
  beforeEach(() => {
    request.cookie = undefined;
  });

  test('the classic theme cookie', async () => {
    assert({
      given: 'theme=light, theme=dark and theme=system',
      should: 'render <html data-theme> in the served HTML, before any script runs',
      actual: [
        dataTheme(await renderHtml('light')),
        dataTheme(await renderHtml('dark')),
        dataTheme(await renderHtml('system')),
      ],
      expected: ['light', 'dark', 'system'],
    });
  });

  test('no or an unknown cookie', async () => {
    assert({
      given: 'no theme cookie and an unknown value',
      should: 'render the system theme, as classic does',
      actual: [
        dataTheme(await renderHtml(undefined)),
        dataTheme(await renderHtml('sepia')),
      ],
      expected: ['system', 'system'],
    });
  });
});
