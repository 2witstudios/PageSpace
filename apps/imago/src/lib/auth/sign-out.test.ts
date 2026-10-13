import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { LOGOUT_ENDPOINT, signOut } from './sign-out';

type Call = { input: string; init?: RequestInit };

const recorder = (respond: () => Promise<Response>) => {
  const calls: Call[] = [];
  const navigations: string[] = [];
  return {
    calls,
    navigations,
    fetch: (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return respond();
    },
    navigate: (url: string) => {
      navigations.push(url);
    },
  };
};

describe('signOut()', () => {
  test('logout call', async () => {
    const io = recorder(async () => Response.json({ message: 'Logged out successfully' }));
    await signOut(io);

    assert({
      given: 'a sign-out',
      should: "POST to web's logout endpoint, outside imago's basePath",
      actual: io.calls.map(({ input, init }) => ({ input, method: init?.method })),
      expected: [{ input: '/api/auth/logout', method: 'POST' }],
    });

    assert({
      given: 'a sign-out',
      should: 'send the session cookie with the logout call',
      actual: io.calls[0]?.init?.credentials,
      expected: 'same-origin',
    });

    assert({
      given: 'the logout endpoint constant',
      should: "be web's root-relative logout route",
      actual: LOGOUT_ENDPOINT,
      expected: '/api/auth/logout',
    });
  });

  test('landing', async () => {
    const io = recorder(async () => Response.json({ message: 'Logged out successfully' }));
    await signOut(io);

    assert({
      given: 'a completed logout',
      should: "land on classic's sign-in",
      actual: io.navigations,
      expected: ['/auth/signin'],
    });
  });

  test('ordering', async () => {
    const order: string[] = [];
    await signOut({
      fetch: async () => {
        await Promise.resolve();
        order.push('logout');
        return new Response(null, { status: 200 });
      },
      navigate: () => {
        order.push('navigate');
      },
    });

    assert({
      given: 'a sign-out',
      should: 'leave only after the logout call settles, so the cookie is cleared first',
      actual: order,
      expected: ['logout', 'navigate'],
    });
  });

  test('a failed logout call', async () => {
    const rejected = recorder(() => Promise.reject(new TypeError('Failed to fetch')));
    await signOut(rejected);

    assert({
      given: 'a logout call that never reaches the server',
      should: 'still land on sign-in',
      actual: rejected.navigations,
      expected: ['/auth/signin'],
    });

    const errored = recorder(async () => new Response(null, { status: 500 }));
    await signOut(errored);

    assert({
      given: 'a logout call the server answers with an error',
      should: 'still land on sign-in',
      actual: errored.navigations,
      expected: ['/auth/signin'],
    });
  });
});
