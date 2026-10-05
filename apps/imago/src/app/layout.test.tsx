import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { useThemePreference } from '@/lib/theme/theme-provider';

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

const renderHtml = async (
  cookie: string | undefined,
  children: React.ReactNode = null,
): Promise<string> => {
  request.cookie = cookie;
  const { default: RootLayout } = await import('./layout');
  return renderToStaticMarkup(await RootLayout({ children }));
};

function ThemeProbe() {
  return <p>{useThemePreference().preference}</p>;
}

const dataTheme = (html: string): string | undefined =>
  html.match(/<html[^>]*\sdata-theme="([^"]*)"/)?.[1];

describe('RootLayout theme', () => {
  // The layout renders only while imago is on (IMG-1.8's IMAGO_ENABLED gate).
  beforeEach(() => {
    request.cookie = undefined;
    vi.stubEnv('IMAGO_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  test('the theme switcher state', async () => {
    const probed = async (cookie: string | undefined) =>
      /<p>([^<]*)<\/p>/.exec(await renderHtml(cookie, <ThemeProbe />))?.[1];

    assert({
      given: 'each theme cookie and none',
      should: "seed the page's theme state with the same preference as data-theme",
      actual: [
        await probed('light'),
        await probed('dark'),
        await probed('system'),
        await probed(undefined),
      ],
      expected: ['light', 'dark', 'system', 'system'],
    });
  });
});

const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404';

const renderOrDigest = async (): Promise<{ html: string | null; digest: string | null }> => {
  try {
    return { html: await renderHtml(undefined), digest: null };
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    return { html: null, digest: typeof digest === 'string' ? digest : null };
  }
};

// A router prefetch skips middleware (see its matcher), so the layout is what
// keeps those requests from rendering imago while it is switched off.
// notFound() is the real one, so its digest is what Next acts on.
describe('RootLayout IMAGO_ENABLED backstop', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('flag off', async () => {
    for (const flag of [undefined, 'false', '', 'TRUE', '1']) {
      vi.stubEnv('IMAGO_ENABLED', flag);

      assert({
        given: `IMAGO_ENABLED=${JSON.stringify(flag)}`,
        should: 'answer notFound() instead of rendering',
        actual: await renderOrDigest(),
        expected: { html: null, digest: NOT_FOUND_DIGEST },
      });
    }
  });

  test('flag on', async () => {
    vi.stubEnv('IMAGO_ENABLED', 'true');
    const { html, digest } = await renderOrDigest();

    assert({
      given: "IMAGO_ENABLED='true'",
      should: 'render the page with the request nonce on the webpack nonce script',
      actual: [digest, html?.includes('<script nonce="test-nonce">')],
      expected: [null, true],
    });
  });
});
