import { describe, it, expect } from 'vitest';
import { toggleAllowlist, policyChangeSummary, allowlistLabel } from '../org-policies';

describe('toggleAllowlist', () => {
  const all = ['anthropic', 'openai', 'google', 'xai'];
  it('POL-8 (partial): unchecking one from Unrestricted allows every other one, explicitly', () => {
    expect(toggleAllowlist(null, 'xai', all)).toEqual(['anthropic', 'openai', 'google']);
  });

  it('checks and unchecks within a list, keeping the catalog order', () => {
    expect(toggleAllowlist(['openai'], 'anthropic', all)).toEqual(['anthropic', 'openai']);
    expect(toggleAllowlist(['anthropic', 'openai'], 'openai', all)).toEqual(['anthropic']);
  });

  it('can narrow to nothing (an empty list allows nothing, never everything)', () => {
    expect(toggleAllowlist(['openai'], 'openai', all)).toEqual([]);
  });

  it('keeps ids the catalog no longer lists', () => {
    expect(toggleAllowlist(['retired', 'openai'], 'anthropic', all)).toEqual(['anthropic', 'openai', 'retired']);
  });
});

describe('allowlistLabel', () => {
  it('reads Unrestricted, None, or the count allowed', () => {
    expect(allowlistLabel(null, 4)).toBe('Unrestricted');
    expect(allowlistLabel([], 4)).toBe('None allowed');
    expect(allowlistLabel(['a', 'b'], 4)).toBe('2 of 4 allowed');
  });
});

describe('policyChangeSummary', () => {
  it('POL-1 (partial): names what a change suspended, restored or newly blocked', () => {
    expect(policyChangeSummary({ suspended: { publicShareLinks: 4 }, restored: {}, blocked: {} })).toBe('Saved. 4 existing share links suspended.');
    expect(policyChangeSummary({ suspended: {}, restored: { publishedPages: 2 }, blocked: {} })).toBe('Saved. 2 published pages restored.');
    expect(policyChangeSummary({ suspended: { guests: 1, integrations: 3 }, restored: {}, blocked: { publishedApps: 2 } })).toBe(
      'Saved. 1 guest suspended, 3 service connections suspended. 2 published apps now blocked.',
    );
    expect(policyChangeSummary({ suspended: {}, restored: {}, blocked: {} })).toBe('Saved.');
    expect(policyChangeSummary({ suspended: { publicShareLinks: 0 }, restored: {}, blocked: {} })).toBe('Saved.');
  });
});
