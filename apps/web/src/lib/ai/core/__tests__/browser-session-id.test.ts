import { describe, test, beforeEach, afterEach, vi } from 'vitest';
import { assert } from './riteway';

describe('getBrowserSessionId', () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  test('SSR environment', async () => {
    vi.stubGlobal('sessionStorage', undefined);
    const { getBrowserSessionId } = await import('../browser-session-id');
    assert({
      given: 'sessionStorage is undefined (SSR)',
      should: 'return the sentinel "ssr" string',
      actual: getBrowserSessionId(),
      expected: 'ssr',
    });
  });

  test('first call generates and stores a UUID', async () => {
    const { getBrowserSessionId } = await import('../browser-session-id');
    const id = getBrowserSessionId();
    assert({
      given: 'an empty sessionStorage',
      should: 'persist a UUID under ps-browser-session-id',
      actual: { stored: sessionStorage.getItem('ps-browser-session-id'), uuidLike: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) },
      expected: { stored: id, uuidLike: true },
    });
  });

  test('repeat calls return the same value', async () => {
    const { getBrowserSessionId } = await import('../browser-session-id');
    const first = getBrowserSessionId();
    assert({
      given: 'a stored browser session id',
      should: 'return the same value on every subsequent call',
      actual: getBrowserSessionId(),
      expected: first,
    });
  });

  test('reads existing value without regenerating', async () => {
    sessionStorage.setItem('ps-browser-session-id', 'pinned-session');
    const { getBrowserSessionId } = await import('../browser-session-id');
    assert({
      given: 'a value already at the sessionStorage key',
      should: 'return that value verbatim',
      actual: getBrowserSessionId(),
      expected: 'pinned-session',
    });
  });
});
