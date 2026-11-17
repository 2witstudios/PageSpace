/**
 * The Reports tab and the reports on a linked case: every pending case is reachable a page at a time, a failed
 * load says so with a retry, and a linked case never shows reports fetched for another case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReportedCaseSummary } from '@/lib/content/report-summary';

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));

type QueryState = { data: unknown; dataUrl: string | null; error: string | null; isLoading: boolean; isFetching: boolean };
const { query } = vi.hoisted(() => ({ query: { current: null as QueryState | null, urls: [] as string[] } }));
vi.mock('@/hooks/use-admin-query', () => ({
  useAdminQuery: (url: string) => {
    query.urls.push(url);
    return { ...query.current, refetch: () => {} };
  },
  dataForUrl: (url: string | null, state: { data: unknown; dataUrl: string | null }) =>
    url !== null && state.dataUrl === url ? state.data : null,
}));

import { LinkedCaseReports, ReportsPager, REPORTS_PAGE_SIZE } from '../reports-tab';

const summary = (id: string): ReportedCaseSummary => ({
  case: {
    id, targetType: 'page', targetId: `page_${id}`, contentHash: null, status: 'reported', category: null, reason: null,
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', actorUserId: null, evidencePreserved: false, otherObjectsPreserved: 0,
    progress: { kind: null, steps: [], resumable: false, resweepable: false, restorable: false } as unknown as ReportedCaseSummary['case']['progress'],
    references: null, skippedDrives: [],
  },
  reportCount: 1,
  reports: [{ id: `r_${id}`, category: 'other', source: 'anonymous', reporterUserId: null, contactEmail: null, description: `about ${id}`, createdAt: '2026-11-12T00:00:01.000Z' }],
});

const disabled = (html: string, label: string) => new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`).test(html);

describe('ReportsPager', () => {
  it('offers the next page when this one is full, and no previous page on the first', () => {
    const html = renderToStaticMarkup(<ReportsPager offset={0} shown={REPORTS_PAGE_SIZE} onPage={() => {}} />);
    expect(html).toContain(`Cases 1–${REPORTS_PAGE_SIZE}`);
    expect(disabled(html, 'Previous')).toBe(true);
    expect(disabled(html, 'Next')).toBe(false);
  });

  it('offers no next page after a short page', () => {
    const html = renderToStaticMarkup(<ReportsPager offset={REPORTS_PAGE_SIZE} shown={3} onPage={() => {}} />);
    expect(html).toContain(`Cases ${REPORTS_PAGE_SIZE + 1}–${REPORTS_PAGE_SIZE + 3}`);
    expect(disabled(html, 'Previous')).toBe(false);
    expect(disabled(html, 'Next')).toBe(true);
  });

  it('shows nothing when everything fits on the first page', () => {
    expect(renderToStaticMarkup(<ReportsPager offset={0} shown={3} onPage={() => {}} />)).toBe('');
  });
});

describe('LinkedCaseReports', () => {
  beforeEach(() => {
    query.urls = [];
  });
  const urlFor = (id: string) => `/api/admin/content/reports?id=${id}`;

  it('shows the reports fetched for this case', () => {
    query.current = { data: { cases: [summary('B')] }, dataUrl: urlFor('B'), error: null, isLoading: false, isFetching: false };
    const html = renderToStaticMarkup(<LinkedCaseReports caseId="B" onReview={() => {}} />);
    expect(query.urls).toContain(urlFor('B'));
    expect(html).toContain('about B');
  });

  it('never shows the reports of the case linked before, while this one loads or after it fails', () => {
    query.current = { data: { cases: [summary('A')] }, dataUrl: urlFor('A'), error: null, isLoading: false, isFetching: true };
    expect(renderToStaticMarkup(<LinkedCaseReports caseId="B" onReview={() => {}} />)).not.toContain('about A');
    query.current = { ...query.current, isFetching: false, error: 'Request failed (500)' };
    expect(renderToStaticMarkup(<LinkedCaseReports caseId="B" onReview={() => {}} />)).not.toContain('about A');
  });

  it('says when the reports could not be loaded, with a retry, instead of looking like a case with no reports', () => {
    query.current = { data: null, dataUrl: null, error: 'Request failed (500)', isLoading: false, isFetching: false };
    const html = renderToStaticMarkup(<LinkedCaseReports caseId="B" onReview={() => {}} />);
    expect(html).toContain('Could not load the reports on this case');
    expect(html).toContain('Retry');
  });
});
