/**
 * behavioural tests once each module has its own dedicated suite.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock @pagespace/db since version-resolver imports it
vi.mock('@pagespace/db', () => ({
  db: { select: vi.fn() },
  pageVersions: {},
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  desc: vi.fn(),
}));

import * as content from '../index';

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
