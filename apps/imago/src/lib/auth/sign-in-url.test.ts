import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  basePathRelative,
  imagoReturnPath,
  requestOrigin,
  signInLocation,
  signInOrigin,
} from './sign-in-url';

const nextOf = (location: string): string | null => new URL(location).searchParams.get('next');

describe('imagoReturnPath()', () => {
  test('paths under the basePath', () => {
    assert({
      given: 'the imago root (basePath-relative "/")',
      should: 'return /imago',
      actual: imagoReturnPath('/'),
      expected: '/imago',
    });

    assert({
      given: 'a nested imago path',
      should: 'prefix it with the basePath',
      actual: imagoReturnPath('/drive-1/files/page-9'),
      expected: '/imago/drive-1/files/page-9',
    });

    assert({
      given: 'a percent-encoded segment',
      should: 'keep it as requested',
      actual: imagoReturnPath('/drive-1/files/caf%C3%A9'),
      expected: '/imago/drive-1/files/caf%C3%A9',
    });
  });

  test('look-alikes and smuggling attempts', () => {
    const cases: Array<[string, string]> = [
      ['a protocol-relative path', '//evil.com'],
      ['a doubled slash mid-path', '/drive-1//evil.com'],
      ['a backslash', '/\\evil.com'],
      ['an encoded backslash', '/%5Cevil.com'],
      ['an encoded double slash', '/%2F%2Fevil.com'],
      ['a dot-segment escape', '/../auth/signin'],
      ['an encoded dot-segment escape', '/%2e%2e/auth/signin'],
      ['a scheme in the path', '/javascript:alert(1)'],
      ['an encoded scheme in the path', '/javascript%3Aalert(1)'],
      ['an absolute URL', 'https://evil.com/imago'],
      ['a path without a leading slash', 'evil.com'],
      ['a malformed escape', '/%E0%A4%A'],
      ['a control character', '/a%0d%0aLocation:evil'],
    ];

    for (const [given, pathname] of cases) {
      assert({
        given,
        should: 'fall back to the bare /imago root',
        actual: imagoReturnPath(pathname),
        expected: '/imago',
      });
    }
  });

  test('missing input', () => {
    assert({
      given: 'no pathname (a request middleware never saw)',
      should: 'fall back to the bare /imago root',
      actual: imagoReturnPath(null),
      expected: '/imago',
    });
  });
});

describe('signInLocation()', () => {
  test('redirect target', () => {
    const location = signInLocation({
      origin: 'https://pagespace.ai',
      pathname: '/drive-1/files',
    });

    assert({
      given: 'an imago path',
      should: "point at classic's sign-in on the same origin, outside the basePath",
      actual: `${new URL(location).origin}${new URL(location).pathname}`,
      expected: 'https://pagespace.ai/auth/signin',
    });

    assert({
      given: 'an imago path',
      should: 'carry the requested imago path as next=',
      actual: nextOf(location),
      expected: '/imago/drive-1/files',
    });

    assert({
      given: 'an imago path',
      should: 'carry no other query parameter',
      actual: [...new URL(location).searchParams.keys()],
      expected: ['next'],
    });
  });

  test('look-alike path', () => {
    assert({
      given: 'a protocol-relative look-alike',
      should: 'never forward it as next=',
      actual: nextOf(signInLocation({ origin: 'https://pagespace.ai', pathname: '//evil.com' })),
      expected: '/imago',
    });
  });
});

describe('requestOrigin()', () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  test('origin from the request', () => {
    assert({
      given: 'a Host header and a forwarded https proto',
      should: 'build the https origin',
      actual: requestOrigin(headers({ host: 'pagespace.ai', 'x-forwarded-proto': 'https' })),
      expected: 'https://pagespace.ai',
    });

    assert({
      given: 'a proxy chain of forwarded protos',
      should: 'use the first (client-facing) one',
      actual: requestOrigin(headers({ host: 'pagespace.ai', 'x-forwarded-proto': 'https, http' })),
      expected: 'https://pagespace.ai',
    });

    assert({
      given: 'a Host header and no forwarded proto',
      should: 'default to http',
      actual: requestOrigin(headers({ host: 'localhost:3006' })),
      expected: 'http://localhost:3006',
    });
  });

  test('untrusted values', () => {
    assert({
      given: 'a forwarded proto that is not http or https',
      should: 'default to http',
      actual: requestOrigin(headers({ host: 'pagespace.ai', 'x-forwarded-proto': 'javascript' })),
      expected: 'http://pagespace.ai',
    });

    let error: unknown;
    try {
      requestOrigin(headers({ host: 'evil.com/path@x' }));
    } catch (caught) {
      error = caught;
    }
    assert({
      given: 'a Host header that is not a bare host',
      should: 'refuse to build an origin from it',
      actual: error instanceof Error,
      expected: true,
    });

    let missing: unknown;
    try {
      requestOrigin(headers({}));
    } catch (caught) {
      missing = caught;
    }
    assert({
      given: 'no Host header',
      should: 'refuse to build an origin',
      actual: missing instanceof Error,
      expected: true,
    });
  });
});

describe('signInOrigin()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const thrown = (run: () => unknown): string | null => {
    try {
      run();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  test('production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WEB_APP_URL', 'https://elsewhere.example');

    assert({
      given: 'a production server, even with a web app URL configured',
      should: 'keep sign-in on the origin imago was served from',
      actual: signInOrigin('https://pagespace.ai'),
      expected: 'https://pagespace.ai',
    });
  });

  test('tests and any other non-development env', () => {
    vi.stubEnv('NODE_ENV', 'test');

    assert({
      given: 'a NODE_ENV other than development',
      should: 'keep sign-in on the origin imago was served from',
      actual: signInOrigin('http://localhost:3006'),
      expected: 'http://localhost:3006',
    });
  });

  test('next dev', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_WEB_APP_URL', '');

    assert({
      given: 'next dev with no web app URL configured',
      should: "send sign-in to apps/web's default dev origin, which serves the page",
      actual: signInOrigin('http://localhost:3006'),
      expected: 'http://localhost:3000',
    });

    vi.stubEnv('NEXT_PUBLIC_WEB_APP_URL', 'http://127.0.0.1:4000/some/path?x=1');

    assert({
      given: 'next dev with a configured web app URL',
      should: 'use only that URL\'s origin',
      actual: signInOrigin('http://localhost:3006'),
      expected: 'http://127.0.0.1:4000',
    });
  });

  test('a misconfigured web app URL in next dev', () => {
    vi.stubEnv('NODE_ENV', 'development');

    vi.stubEnv('NEXT_PUBLIC_WEB_APP_URL', 'not a url');
    assert({
      given: 'a value that is not a URL',
      should: 'refuse to build a sign-in origin',
      actual: thrown(() => signInOrigin('http://localhost:3006')),
      expected: 'NEXT_PUBLIC_WEB_APP_URL is not a valid http(s) URL: "not a url"',
    });

    vi.stubEnv('NEXT_PUBLIC_WEB_APP_URL', 'javascript:alert(1)');
    assert({
      given: 'a non-http scheme',
      should: 'refuse to build a sign-in origin',
      actual: thrown(() => signInOrigin('http://localhost:3006')),
      expected: 'NEXT_PUBLIC_WEB_APP_URL is not a valid http(s) URL: "javascript:alert(1)"',
    });
  });
});

describe('basePathRelative()', () => {
  test('paths under the basePath', () => {
    const cases: Array<[string, string]> = [
      ['/imago', '/'],
      ['/imago/', '/'],
      ['/imago/drive-1/files/page-9', '/drive-1/files/page-9'],
    ];
    for (const [pathname, expected] of cases) {
      assert({
        given: `the browser path ${pathname}`,
        should: 'strip the basePath',
        actual: basePathRelative(pathname),
        expected,
      });
    }
  });

  test('paths outside the basePath', () => {
    for (const pathname of ['/imagoevil', '/auth/signin', '/', '']) {
      assert({
        given: `the browser path "${pathname}"`,
        should: 'not claim it as an imago path',
        actual: basePathRelative(pathname),
        expected: null,
      });
    }
  });
});
