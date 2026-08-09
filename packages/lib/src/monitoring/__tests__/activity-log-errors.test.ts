/**
 * Tests for activity-log-errors.ts — pageId FK violation detection.
 *
 * Drizzle wraps driver errors, so the pg error fields live under `.cause`.
 * These cases pin both the wrapped and the flat (legacy) shapes.
 */

import { describe, it, expect } from 'vitest';
import { isPageIdForeignKeyError } from '../activity-log-errors';

describe('isPageIdForeignKeyError', () => {
  it('should detect the production shape: pg error nested under .cause', () => {
    const error = Object.assign(
      new Error('Failed query: insert into "activity_logs" ("id", "userId") values ($1, $2)'),
      {
        cause: Object.assign(
          new Error('insert or update on table "activity_logs" violates foreign key constraint'),
          {
            code: '23503',
            constraint: 'activity_logs_pageId_pages_id_fk',
            detail: 'Key (pageId)=(c2npdiezknc9adz0f91masv6) is not present in table "pages".',
          }
        ),
      }
    );
    expect(isPageIdForeignKeyError(error)).toBe(true);
  });

  it('should detect a flat error carrying code and constraint', () => {
    const error = Object.assign(new Error('FK error'), {
      code: '23503',
      constraint: 'activity_logs_pageId_pages_id_fk',
    });
    expect(isPageIdForeignKeyError(error)).toBe(true);
  });

  it('should detect an FK error nested two cause levels deep', () => {
    const error = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('middle'), {
        cause: Object.assign(new Error('inner'), {
          code: '23503',
          constraint: 'activity_logs_pageId_pages_id_fk',
        }),
      }),
    });
    expect(isPageIdForeignKeyError(error)).toBe(true);
  });

  it('should fall back to detail when constraint is absent', () => {
    const error = Object.assign(new Error('FK violation'), {
      code: '23503',
      detail: 'Key (pageId)=(page-1) is not present in table "pages".',
    });
    expect(isPageIdForeignKeyError(error)).toBe(true);
  });

  it('should return false for a 23503 on a different column', () => {
    const error = Object.assign(new Error('FK violation'), {
      code: '23503',
      constraint: 'activity_logs_driveId_drives_id_fk',
      detail: 'Key (driveId)=(drive-1) is not present in table "drives".',
    });
    expect(isPageIdForeignKeyError(error)).toBe(false);
  });

  it('should return false for a 23503 with no constraint and no detail', () => {
    const error = Object.assign(new Error('FK violation'), { code: '23503' });
    expect(isPageIdForeignKeyError(error)).toBe(false);
  });

  it('should return false for a non-23503 code even on the pageId constraint', () => {
    const error = Object.assign(new Error('unique violation'), {
      code: '23505',
      constraint: 'activity_logs_pageId_pages_id_fk',
    });
    expect(isPageIdForeignKeyError(error)).toBe(false);
  });

  it('should return false for null', () => {
    expect(isPageIdForeignKeyError(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isPageIdForeignKeyError(undefined)).toBe(false);
  });

  it('should return false for a string', () => {
    expect(isPageIdForeignKeyError('23503 activity_logs_pageId_pages_id_fk')).toBe(false);
  });

  it('should return false for a plain object with no pg fields', () => {
    expect(isPageIdForeignKeyError({ message: 'nope' })).toBe(false);
  });

  it('should detect a non-Error object carrying the pg fields', () => {
    expect(
      isPageIdForeignKeyError({ code: '23503', constraint: 'activity_logs_pageId_pages_id_fk' })
    ).toBe(true);
  });

  it('should return false for an Error with no extra fields', () => {
    expect(isPageIdForeignKeyError(new Error('boom'))).toBe(false);
  });

  it('should return false when detail is present but not a string', () => {
    const error = Object.assign(new Error('FK violation'), {
      code: '23503',
      detail: { column: 'pageId' },
    });
    expect(isPageIdForeignKeyError(error)).toBe(false);
  });

  it('should terminate on a cyclic cause chain', () => {
    const a = Object.assign(new Error('a'), { cause: undefined as unknown });
    const b = Object.assign(new Error('b'), { cause: a });
    a.cause = b;
    expect(isPageIdForeignKeyError(a)).toBe(false);
  });

  it('should stop walking beyond the depth limit', () => {
    // 10 nested wrappers before the real error — deeper than any real driver chain
    let error: unknown = Object.assign(new Error('inner'), {
      code: '23503',
      constraint: 'activity_logs_pageId_pages_id_fk',
    });
    for (let i = 0; i < 10; i++) {
      error = Object.assign(new Error(`wrapper-${i}`), { cause: error });
    }
    expect(isPageIdForeignKeyError(error)).toBe(false);
  });
});
