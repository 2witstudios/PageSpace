import { describe, it, expect } from 'vitest';
import { mergeReportPages, type ReportSummary } from '../report-summary';

const report = (id: string): ReportSummary => ({
  id, category: 'other', source: 'anonymous', reporterUserId: null, contactEmail: null, description: id, createdAt: '2026-11-12T00:00:00.000Z',
});

describe('mergeReportPages', () => {
  it('appends a later page after the reports already shown', () => {
    expect(mergeReportPages([report('a'), report('b')], [report('c')]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a report the page repeats, so none is shown twice', () => {
    expect(mergeReportPages([report('a'), report('b')], [report('b'), report('c')]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});
