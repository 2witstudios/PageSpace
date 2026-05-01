import { describe, it, expect } from 'vitest';
import { shouldRefreshOnReconnect } from '../shouldRefreshOnReconnect';

describe('shouldRefreshOnReconnect', () => {
  it('given a transition from disconnected to connected after the initial connect, should refresh', () => {
    expect(shouldRefreshOnReconnect('disconnected', 'connected', true)).toBe(true);
  });

  it('given a transition from error to connected after the initial connect, should refresh', () => {
    expect(shouldRefreshOnReconnect('error', 'connected', true)).toBe(true);
  });

  it('given the very first connect (hadInitialConnect=false), should NOT refresh — the mount-time load already covers it', () => {
    expect(shouldRefreshOnReconnect(null, 'connected', false)).toBe(false);
  });

  it('given a status change while still connected (e.g. dep change firing the effect), should NOT refresh', () => {
    expect(shouldRefreshOnReconnect('connected', 'connected', true)).toBe(false);
  });

  it('given a transition INTO a non-connected state, should NOT refresh', () => {
    expect(shouldRefreshOnReconnect('connected', 'disconnected', true)).toBe(false);
  });

  it('given prevStatus null and connected after initial connect already happened, should refresh (covers the unusual ref-reset case)', () => {
    expect(shouldRefreshOnReconnect(null, 'connected', true)).toBe(true);
  });
});
