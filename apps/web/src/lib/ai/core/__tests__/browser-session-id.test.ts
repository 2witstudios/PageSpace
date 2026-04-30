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
      given: 'a value already at the new key',
      should: 'return that value verbatim',
      actual: getBrowserSessionId(),
      expected: 'pinned-session',
    });
  });

  test('migrates legacy ps-tab-id to ps-browser-session-id', async () => {
    sessionStorage.setItem('ps-tab-id', 'legacy-uuid-value');
    const { getBrowserSessionId } = await import('../browser-session-id');
    const returned = getBrowserSessionId();
    assert({
      given: 'sessionStorage contains the legacy ps-tab-id key',
      should: 'migrate the value to ps-browser-session-id and remove the legacy key',
      actual: {
        returned,
        newKey: sessionStorage.getItem('ps-browser-session-id'),
        legacy: sessionStorage.getItem('ps-tab-id'),
      },
      expected: {
        returned: 'legacy-uuid-value',
        newKey: 'legacy-uuid-value',
        legacy: null,
      },
    });
  });

  test('legacy migration prefers the new key when both exist', async () => {
    sessionStorage.setItem('ps-browser-session-id', 'new-value');
    sessionStorage.setItem('ps-tab-id', 'legacy-value');
    const { getBrowserSessionId } = await import('../browser-session-id');
    assert({
      given: 'both legacy and new keys are populated',
      should: 'return the new key without touching the legacy key',
      actual: {
        returned: getBrowserSessionId(),
        legacy: sessionStorage.getItem('ps-tab-id'),
      },
      expected: {
        returned: 'new-value',
        legacy: 'legacy-value',
      },
    });
  });
});
