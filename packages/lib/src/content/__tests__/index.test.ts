import { describe, it, expect } from 'vitest';

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

describe('content/index barrel export', () => {
  it('exports buildTree from tree-utils', () => {
    expect(content.buildTree).toBeDefined();
    expect(typeof content.buildTree).toBe('function');
  });

  it('exports calculateSafeDepth from tree-utils', () => {
    expect(content.calculateSafeDepth).toBeDefined();
    expect(typeof content.calculateSafeDepth).toBe('function');
  });

  it('exports formatTreeAsMarkdown from tree-utils', () => {
    expect(content.formatTreeAsMarkdown).toBeDefined();
    expect(typeof content.formatTreeAsMarkdown).toBe('function');
  });

  it('exports filterToSubtree from tree-utils', () => {
    expect(content.filterToSubtree).toBeDefined();
    expect(typeof content.filterToSubtree).toBe('function');
  });

  it('exports sanitizeFilename from export-utils', () => {
    expect(content.sanitizeFilename).toBeDefined();
    expect(typeof content.sanitizeFilename).toBe('function');
  });

  it('exports generateCSV from export-utils', () => {
    expect(content.generateCSV).toBeDefined();
    expect(typeof content.generateCSV).toBe('function');
  });

  it('exports generateDOCX from export-utils', () => {
    expect(content.generateDOCX).toBeDefined();
    expect(typeof content.generateDOCX).toBe('function');
  });

  it('exports generateExcel from export-utils', () => {
    expect(content.generateExcel).toBeDefined();
    expect(typeof content.generateExcel).toBe('function');
  });

  it('exports diffContent from diff-utils', () => {
    expect(content.diffContent).toBeDefined();
    expect(typeof content.diffContent).toBe('function');
  });

  it('exports generateUnifiedDiff from diff-utils', () => {
    expect(content.generateUnifiedDiff).toBeDefined();
    expect(typeof content.generateUnifiedDiff).toBe('function');
  });

  it('exports extractSections from diff-utils', () => {
    expect(content.extractSections).toBeDefined();
    expect(typeof content.extractSections).toBe('function');
  });

  it('exports groupActivitiesForDiff from activity-diff-utils', () => {
    expect(content.groupActivitiesForDiff).toBeDefined();
    expect(typeof content.groupActivitiesForDiff).toBe('function');
  });

  it('exports generateStackedDiff from activity-diff-utils', () => {
    expect(content.generateStackedDiff).toBeDefined();
    expect(typeof content.generateStackedDiff).toBe('function');
  });

  it('exports truncateDiffsToTokenBudget from activity-diff-utils', () => {
    expect(content.truncateDiffsToTokenBudget).toBeDefined();
    expect(typeof content.truncateDiffsToTokenBudget).toBe('function');
  });

  it('exports validatePageCreation from page-type-validators', () => {
    expect(content.validatePageCreation).toBeDefined();
    expect(typeof content.validatePageCreation).toBe('function');
  });

  it('exports validatePageUpdate from page-type-validators', () => {
    expect(content.validatePageUpdate).toBeDefined();
    expect(typeof content.validatePageUpdate).toBe('function');
  });

  it('exports detectPageContentFormat from page-content-format', () => {
    expect(content.detectPageContentFormat).toBeDefined();
    expect(typeof content.detectPageContentFormat).toBe('function');
  });

  it('exports getPageTypeConfig from page-types.config', () => {
    expect(content.getPageTypeConfig).toBeDefined();
    expect(typeof content.getPageTypeConfig).toBe('function');
  });

  it('exports resolveVersionContent from version-resolver', () => {
    expect(content.resolveVersionContent).toBeDefined();
    expect(typeof content.resolveVersionContent).toBe('function');
  });

  it('exports batchResolveVersionContent from version-resolver', () => {
    expect(content.batchResolveVersionContent).toBeDefined();
    expect(typeof content.batchResolveVersionContent).toBe('function');
  });

  it('exports generateDiffsWithinBudget from diff-generator', () => {
    expect(content.generateDiffsWithinBudget).toBeDefined();
    expect(typeof content.generateDiffsWithinBudget).toBe('function');
  });

  it('exports estimateChangeMagnitude from diff-generator', () => {
    expect(content.estimateChangeMagnitude).toBeDefined();
    expect(typeof content.estimateChangeMagnitude).toBe('function');
  });

  it('exports streamDiffsWithinBudget from diff-generator', () => {
    expect(content.streamDiffsWithinBudget).toBeDefined();
    expect(typeof content.streamDiffsWithinBudget).toBe('function');
  });
});
