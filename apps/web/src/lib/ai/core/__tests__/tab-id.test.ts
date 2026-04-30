import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('getTabId', () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('returns "ssr" when sessionStorage is undefined', async () => {
    vi.stubGlobal('sessionStorage', undefined);
    const { getTabId } = await import('../tab-id');
    expect(getTabId()).toBe('ssr');
  });

  it('generates and stores a UUID on first call', async () => {
    const { getTabId } = await import('../tab-id');
    const id = getTabId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sessionStorage.getItem('ps-tab-id')).toBe(id);
  });

  it('returns the same value on repeat calls', async () => {
    const { getTabId } = await import('../tab-id');
    expect(getTabId()).toBe(getTabId());
  });

  it('returns an existing value from sessionStorage without generating a new one', async () => {
    sessionStorage.setItem('ps-tab-id', 'pinned-tab-id');
    const { getTabId } = await import('../tab-id');
    expect(getTabId()).toBe('pinned-tab-id');
  });
});
