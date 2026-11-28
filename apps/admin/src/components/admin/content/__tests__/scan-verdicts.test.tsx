/**
 * The publish-scan verdict counts: a staff dismissal is labelled as one, a verdict with no mode is not, and
 * the counting unit is a distinct file content (one row per hash), never a file.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/hooks/use-admin-query', () => ({
  useAdminQuery: () => ({
    data: { counts: [{ mode: 'shadow', outcome: 'clean', verdict: 'clean', reviewed: false, count: 3 }] },
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: () => {},
  }),
}));

import { ScanVerdicts, verdictTable } from '../scan-verdicts';

describe('verdictTable', () => {
  it('labels only a staff review as "Cleared by staff"; a verdict with no mode and no review is neutral', () => {
    const rows = verdictTable([
      { mode: null, outcome: 'clean', verdict: 'clean', reviewed: true, count: 2 },
      { mode: null, outcome: 'classifier_flag', verdict: 'flagged', reviewed: false, count: 1 },
      { mode: 'enforce', outcome: 'clean', verdict: 'clean', reviewed: false, count: 5 },
    ]);
    expect(rows).toEqual([
      { mode: 'enforce', outcome: 'Clean', count: 5 },
      { mode: 'review', outcome: 'Clean', count: 2 },
      { mode: 'none', outcome: 'Classifier flag (review queue)', count: 1 },
    ]);
  });
});

describe('ScanVerdicts', () => {
  it('counts distinct file contents, not files', () => {
    const html = renderToStaticMarkup(<ScanVerdicts />);
    expect(html).toContain('Distinct contents');
    expect(html).not.toMatch(/>Files</);
    expect(html).toContain('identical files count once');
  });
});
