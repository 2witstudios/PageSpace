import { describe, it, expect } from 'vitest';
import { dataForUrl } from '../use-admin-query';

describe('dataForUrl', () => {
  const a = { target: 'A' };

  it('returns the data when it was fetched for the current URL', () => {
    expect(dataForUrl('/resolve?q=A', { data: a, dataUrl: '/resolve?q=A' })).toBe(a);
  });

  it('withholds the previous lookup\'s data while the next one loads or after it fails', () => {
    expect(dataForUrl('/resolve?q=B', { data: a, dataUrl: '/resolve?q=A' })).toBeNull();
  });

  it('returns nothing when there is no current URL', () => {
    expect(dataForUrl(null, { data: a, dataUrl: '/resolve?q=A' })).toBeNull();
  });

  it('returns nothing before any data has arrived', () => {
    expect(dataForUrl('/resolve?q=A', { data: null, dataUrl: null })).toBeNull();
  });
});
