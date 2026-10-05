// @vitest-environment jsdom
import { beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { BROWSER_SESSION_KEY, browserSessionId } from './browser-session';

beforeEach(() => {
  sessionStorage.clear();
});

describe('browserSessionId()', () => {
  test('minted once per tab', () => {
    const first = browserSessionId();
    assert({
      given: 'a tab with no id yet, asked twice',
      should: 'mint a header-safe id once, keep it in sessionStorage and return it again',
      actual: [/^[A-Za-z0-9_-]{1,64}$/.test(first), browserSessionId() === first, sessionStorage.getItem(BROWSER_SESSION_KEY) === first],
      expected: [true, true, true],
    });
  });

  test("classic's id", () => {
    sessionStorage.setItem(BROWSER_SESSION_KEY, 'classic-tab');
    assert({
      given: 'a tab where classic already minted an id',
      should: 'reuse it',
      actual: browserSessionId(),
      expected: 'classic-tab',
    });
  });
});
