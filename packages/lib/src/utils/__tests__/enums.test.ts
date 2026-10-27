/**
 * Tests for the canonical `PageType` list and the `includeTypes` query-param
 * parser (issue #2150). Three hand re-declarations of the page-type list had
 * drifted from this enum, silently dropping FILE from glob search and the AI
 * `glob_search` tool; every consumer now derives from here.
 *
 * The `AssertSubset` line below is a compile-time-only drift guard against the
 * DB `pgEnum` (`packages/db/src/schema/core.ts`): every application-level
 * `PageTypeValue` must be a valid DB `PageTypeEnum` value, so `tsc` fails right
 * here if a new TS-level type is ever added without a matching migration. It is
 * deliberately ONE-DIRECTIONAL, not exact: the Phase 8 teardown deleted the
 * MACHINE page type from this TS enum (and every validator/config that governs
 * what a page's `type` can be SET to) while leaving the dead `MACHINE` value in
 * the pg enum itself — Postgres cannot `DROP VALUE` — so `PageTypeEnum` (DB) is
 * now a strict superset of `PageTypeValue` (app) by exactly that one value.
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

type AssertSubset<A, B> = A extends B ? true : false;
const everyAppTypeIsAValidDbEnumValue: AssertSubset<PageTypeValue, PageTypeEnum> = true;

describe('PAGE_TYPE_VALUES', () => {
  it('is exactly the members of the PageType enum', () => {
    expect(PAGE_TYPE_VALUES).toEqual(Object.values(PageType));
  });

  it('contains all nine page types, including FILE (#2150)', () => {
    expect([...PAGE_TYPE_VALUES].sort()).toEqual(
      [
        'AI_CHAT',
        'CANVAS',
        'CHANNEL',
        'CODE',
        'DOCUMENT',
        'FILE',
        'FOLDER',
        'SHEET',
        'TASK_LIST',
      ].sort()
    );
  });

  it('no longer contains MACHINE — deleted from the TS enum in the Phase 8 teardown', () => {
    expect(PAGE_TYPE_VALUES).not.toContain('MACHINE');
  });

  it('is a subset of the DB pgEnum (enforced at compile time above)', () => {
    expect(everyAppTypeIsAValidDbEnumValue).toBe(true);
  });
});

describe('isPageTypeValue', () => {
  it('accepts a known page type', () => {
    expect(isPageTypeValue('FOLDER')).toBe(true);
  });

  it('accepts FILE', () => {
    expect(isPageTypeValue('FILE')).toBe(true);
  });

  it('rejects MACHINE — a dead DB-only value nothing may write anymore', () => {
    expect(isPageTypeValue('MACHINE')).toBe(false);
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

  it('parses FILE, the type that used to be dropped (#2150)', () => {
    expect(parsePageTypesParam('FILE')).toEqual(['FILE']);
  });

  it('silently drops MACHINE — a dead value, not an app-level page type', () => {
    expect(parsePageTypesParam('FILE,MACHINE')).toEqual(['FILE']);
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
