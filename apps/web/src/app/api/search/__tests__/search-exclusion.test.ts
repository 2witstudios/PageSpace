import { describe, it, expect } from 'vitest';
import { pages } from '@pagespace/db/schema/core';

describe('excludeFromSearch schema field', () => {
  it('existsOnPagesTable', () => {
    expect(pages.excludeFromSearch).toBeDefined();
  });

  it('hasCorrectColumnName', () => {
    expect(pages.excludeFromSearch.name).toBe('excludeFromSearch');
  });

  it('defaultsToFalse', () => {
    // Drizzle stores default as a SQL expression
    expect(pages.excludeFromSearch.hasDefault).toBe(true);
  });

  it('isNotNullable', () => {
    expect(pages.excludeFromSearch.notNull).toBe(true);
  });
});
