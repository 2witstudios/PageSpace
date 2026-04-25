/**
 * @scaffold — barrel export presence check. Will be replaced by
 * behavioural tests once each module has its own dedicated suite.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock @pagespace/db since version-resolver imports it
vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('@pagespace/db/schema/versioning', () => ({
  pageVersions: {},
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  desc: vi.fn(),
}));

import * as activityDiffUtils from '../activity-diff-utils';
import * as diffUtils from '../diff-utils';
import * as exportUtils from '../export-utils';
import * as pageContentFormat from '../page-content-format';
import * as pageTypeValidators from '../page-type-validators';
import * as pageTypesConfig from '../page-types.config';
import * as treeUtils from '../tree-utils';
import * as versionResolver from '../version-resolver';
import * as diffGenerator from '../diff-generator';

const content = {
  ...activityDiffUtils,
  ...diffUtils,
  ...exportUtils,
  ...pageContentFormat,
  ...pageTypeValidators,
  ...pageTypesConfig,
  ...treeUtils,
  ...versionResolver,
  ...diffGenerator,
};

describe('content/index barrel export @scaffold', () => {
  const expectedExports = [
    // tree-utils
    'buildTree',
    'calculateSafeDepth',
    'formatTreeAsMarkdown',
    'filterToSubtree',
    // export-utils
    'sanitizeFilename',
    'generateCSV',
    'generateDOCX',
    'generateExcel',
    // diff-utils
    'diffContent',
    'generateUnifiedDiff',
    'extractSections',
    // activity-diff-utils
    'groupActivitiesForDiff',
    'generateStackedDiff',
    'truncateDiffsToTokenBudget',
    // page-type-validators
    'validatePageCreation',
    'validatePageUpdate',
    // page-content-format
    'detectPageContentFormat',
    // page-types.config
    'getPageTypeConfig',
    // version-resolver
    'resolveVersionContent',
    'batchResolveVersionContent',
    // diff-generator
    'generateDiffsWithinBudget',
    'estimateChangeMagnitude',
    'streamDiffsWithinBudget',
  ] as const;

  it('exports all expected public functions', () => {
    for (const name of expectedExports) {
      expect(content).toHaveProperty(name);
      expect(typeof (content as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
