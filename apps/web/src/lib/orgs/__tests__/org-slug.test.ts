import { describe, it, expect } from 'vitest';
import { isValidOrgSlug, slugFromOrgName } from '../org-slug';

describe('slugFromOrgName', () => {
  it('UI-6 (partial): previews a URL slug from the organization name', () => {
    expect(slugFromOrgName('Northwind Labs')).toBe('northwind-labs');
  });

  it('drops accents and punctuation and collapses separators', () => {
    expect(slugFromOrgName('  Café  & Co.  ')).toBe('cafe-co');
    expect(slugFromOrgName('A__B--C')).toBe('a-b-c');
  });

  it('stays within the 48-character slug limit without a trailing dash', () => {
    const slug = slugFromOrgName(`${'a'.repeat(47)} b c`);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
    expect(isValidOrgSlug(slug)).toBe(true);
  });

  it('returns an empty slug when the name has no letters or digits', () => {
    expect(slugFromOrgName('!!!')).toBe('');
  });

  it('always produces a slug the create route accepts, or an empty one', () => {
    for (const name of ['Northwind Labs', 'ÆØÅ studio', '123', 'x', '--a--', 'Über Großartig GmbH']) {
      const slug = slugFromOrgName(name);
      expect(slug === '' || isValidOrgSlug(slug), name).toBe(true);
    }
  });
});

describe('isValidOrgSlug', () => {
  it('matches the route schema: 1-48 lowercase letters, digits and inner dashes', () => {
    expect(isValidOrgSlug('northwind')).toBe(true);
    expect(isValidOrgSlug('a')).toBe(true);
    expect(isValidOrgSlug('-a')).toBe(false);
    expect(isValidOrgSlug('a-')).toBe(false);
    expect(isValidOrgSlug('A')).toBe(false);
    expect(isValidOrgSlug('a'.repeat(49))).toBe(false);
    expect(isValidOrgSlug('')).toBe(false);
  });
});
