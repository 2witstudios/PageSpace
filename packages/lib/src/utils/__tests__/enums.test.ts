/**
 * Tests for the canonical `PageType` list and the `includeTypes` query-param
 * parser (issue #2150). Three hand re-declarations of the page-type list had
 * drifted from this enum, silently dropping FILE and MACHINE from glob search
 * and the AI `glob_search` tool; every consumer now derives from here.
 *
 * The `AssertExact` line below is a compile-time-only drift guard against the
 * DB `pgEnum` (`packages/db/src/schema/core.ts`): if the two ever diverge,
 * `tsc` fails right here with "Type 'false' is not assignable to type 'true'"
 * before any test runs. Same pattern as
 * `packages/sdk/src/operations/__tests__/roles-pageperm-drift-guard.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { PageTypeEnum } from '@pagespace/db/schema/core';
import {
  PageType,
  PAGE_TYPE_VALUES,
  isPageTypeValue,
  parsePageTypesParam,
  type PageTypeValue,
} from '../enums';

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const matchesDbEnum: AssertExact<PageTypeValue, PageTypeEnum> = true;

describe('PAGE_TYPE_VALUES', () => {
  it('is exactly the members of the PageType enum', () => {
    expect(PAGE_TYPE_VALUES).toEqual(Object.values(PageType));
  });

  it('contains all ten page types, including FILE and MACHINE (#2150)', () => {
    expect([...PAGE_TYPE_VALUES].sort()).toEqual(
      [
        'AI_CHAT',
        'CANVAS',
        'CHANNEL',
        'CODE',
        'DOCUMENT',
        'FILE',
        'FOLDER',
        'MACHINE',
        'SHEET',
        'TASK_LIST',
      ].sort()
    );
  });

  it('does not drift from the DB pgEnum (enforced at compile time above)', () => {
    expect(matchesDbEnum).toBe(true);
  });
});

describe('isPageTypeValue', () => {
  it('accepts a known page type', () => {
    expect(isPageTypeValue('FOLDER')).toBe(true);
  });

  it('accepts FILE and MACHINE', () => {
    expect(isPageTypeValue('FILE')).toBe(true);
    expect(isPageTypeValue('MACHINE')).toBe(true);
  });

  it('rejects an unknown value', () => {
    expect(isPageTypeValue('BOGUS')).toBe(false);
  });

  it('rejects a differently-cased value', () => {
    expect(isPageTypeValue('folder')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isPageTypeValue('')).toBe(false);
  });
});

describe('parsePageTypesParam', () => {
  it('returns undefined for a null param (no filter)', () => {
    expect(parsePageTypesParam(null)).toBeUndefined();
  });

  it('returns undefined for an empty string (no filter)', () => {
    expect(parsePageTypesParam('')).toBeUndefined();
  });

  it('parses a single valid type', () => {
    expect(parsePageTypesParam('FOLDER')).toEqual(['FOLDER']);
  });

  it('parses FILE and MACHINE, the two types that used to be dropped (#2150)', () => {
    expect(parsePageTypesParam('FILE,MACHINE')).toEqual(['FILE', 'MACHINE']);
  });

  it('parses every page type', () => {
    expect(parsePageTypesParam(PAGE_TYPE_VALUES.join(','))).toEqual([...PAGE_TYPE_VALUES]);
  });

  it('silently drops unknown values but keeps the valid ones', () => {
    expect(parsePageTypesParam('FOLDER,BOGUS,FILE')).toEqual(['FOLDER', 'FILE']);
  });

  it('returns an empty array when every value is unknown', () => {
    expect(parsePageTypesParam('BOGUS')).toEqual([]);
  });

  it('trims surrounding whitespace on each segment', () => {
    expect(parsePageTypesParam(' FOLDER , FILE ')).toEqual(['FOLDER', 'FILE']);
  });

  it('drops empty segments', () => {
    expect(parsePageTypesParam('FOLDER,,DOCUMENT')).toEqual(['FOLDER', 'DOCUMENT']);
  });

  it('drops whitespace-only segments', () => {
    expect(parsePageTypesParam('FOLDER,   ,DOCUMENT')).toEqual(['FOLDER', 'DOCUMENT']);
  });

  it('dedupes repeated types, preserving first-seen order', () => {
    expect(parsePageTypesParam('FILE,FOLDER,FILE')).toEqual(['FILE', 'FOLDER']);
  });

  it('returns an empty array for a param of only separators', () => {
    expect(parsePageTypesParam(',,')).toEqual([]);
  });
});
