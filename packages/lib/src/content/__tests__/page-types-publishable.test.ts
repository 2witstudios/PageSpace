import { describe, it, expect } from 'vitest';
import {
  PAGE_TYPE_CONFIGS,
  isPublishablePageType,
  getPublishablePageTypes,
} from '../page-types.config';
import { PageType } from '../../utils/enums';

const assert = ({ given, should, actual, expected }: { given: string; should: string; actual: unknown; expected: unknown }) =>
  expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

/**
 * Publishing is lifted from a CANVAS-only hard gate to a per-type capability.
 * Publishable types are exactly the ones whose content lives in
 * `pages.content` and can be rendered standalone: CANVAS, DOCUMENT, CODE,
 * SHEET. The rest (folders, chat, tasks, files, machines) store their real
 * content in other tables or object storage and cannot be published.
 */
const PUBLISHABLE_TYPES = [
  PageType.CANVAS,
  PageType.DOCUMENT,
  PageType.CODE,
  PageType.SHEET,
] as const;

const NON_PUBLISHABLE_TYPES = [
  PageType.FOLDER,
  PageType.CHANNEL,
  PageType.AI_CHAT,
  PageType.FILE,
  PageType.TASK_LIST,
  PageType.MACHINE,
] as const;

describe('publishable page-type capability', () => {
  it('declares publishable on every page type config', () => {
    for (const config of Object.values(PAGE_TYPE_CONFIGS)) {
      assert({
        given: `the ${config.type} config`,
        should: 'declare a boolean publishable capability',
        actual: typeof config.capabilities.publishable,
        expected: 'boolean',
      });
    }
  });

  it('marks content-bearing types publishable', () => {
    for (const type of PUBLISHABLE_TYPES) {
      assert({
        given: `page type ${type} (content lives in pages.content)`,
        should: 'be publishable',
        actual: PAGE_TYPE_CONFIGS[type].capabilities.publishable,
        expected: true,
      });
    }
  });

  it('marks types whose content lives outside pages.content as not publishable', () => {
    for (const type of NON_PUBLISHABLE_TYPES) {
      assert({
        given: `page type ${type} (content in chat/tasks tables, object storage, or machine state)`,
        should: 'not be publishable',
        actual: PAGE_TYPE_CONFIGS[type].capabilities.publishable,
        expected: false,
      });
    }
  });
});

describe('isPublishablePageType()', () => {
  it('returns true for each publishable type', () => {
    for (const type of PUBLISHABLE_TYPES) {
      assert({
        given: `page type ${type}`,
        should: 'return true',
        actual: isPublishablePageType(type),
        expected: true,
      });
    }
  });

  it('returns false for each non-publishable type', () => {
    for (const type of NON_PUBLISHABLE_TYPES) {
      assert({
        given: `page type ${type}`,
        should: 'return false',
        actual: isPublishablePageType(type),
        expected: false,
      });
    }
  });

  it('returns false for an unknown type instead of throwing', () => {
    assert({
      given: 'a value not present in PAGE_TYPE_CONFIGS',
      should: 'return false',
      actual: isPublishablePageType('NOT_A_REAL_TYPE' as PageType),
      expected: false,
    });
  });
});

describe('getPublishablePageTypes()', () => {
  it('returns exactly the publishable types', () => {
    assert({
      given: 'the full page-type config table',
      should: 'return exactly CANVAS, DOCUMENT, CODE, SHEET',
      actual: [...getPublishablePageTypes()].sort(),
      expected: [...PUBLISHABLE_TYPES].sort(),
    });
  });
});
