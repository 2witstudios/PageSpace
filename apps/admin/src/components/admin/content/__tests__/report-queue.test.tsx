/**
 * A reporter's words may be abusive, carry markup or carry links. The queue must
 * show them as plain text: escaped, and never turned into an anchor.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));

import { ReportQueue } from '../report-queue';
import type { ReportedCaseSummary } from '@/lib/content/report-summary';

const item = (overrides: Partial<ReportedCaseSummary> = {}): ReportedCaseSummary => ({
  case: {
    id: 'case-r', targetType: 'page', targetId: 'page_1', contentHash: null, status: 'reported', category: 'csam', reason: null,
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', actorUserId: null, evidencePreserved: false, otherObjectsPreserved: 0,
    progress: { kind: null, steps: [], resumable: false, resweepable: false, restorable: false } as unknown as ReportedCaseSummary['case']['progress'],
    references: null, skippedDrives: [],
  },
  reportCount: 3,
  reports: [
    { id: 'r1', category: 'csam', source: 'anonymous', reporterUserId: null, contactEmail: 'me@example.com', description: '<script>alert(1)</script><a href="https://evil.test">click</a> https://evil.test/x', createdAt: '2026-11-12T00:00:01.000Z' },
    { id: 'r2', category: 'harassment', source: 'signed_in', reporterUserId: 'user_r', contactEmail: null, description: null, createdAt: '2026-11-12T00:00:02.000Z' },
  ],
  ...overrides,
});

describe('ReportQueue', () => {
  const html = renderToStaticMarkup(<ReportQueue items={[item()]} onChanged={() => {}} onReview={() => {}} />);

  it('renders the reporter text escaped, with no element or link made from it', () => {
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toMatch(/href="/);
    expect(html).toContain('&lt;a href=&quot;https://evil.test&quot;&gt;click');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('https://evil.test/x');
  });

  it('shows each report with category, time, and the reporter as a user ID or "anonymous"', () => {
    expect(html).toContain('user_r');
    expect(html).toContain('anonymous');
    expect(html).toContain('Harassment or abuse');
    expect(html).toContain('3 reports');
    expect(html).toContain('Showing the latest 2 of 3.');
  });

  it('offers the reports past the first page instead of leaving them out of reach', () => {
    expect(html).toContain('Show 1 more report');
    const all = renderToStaticMarkup(<ReportQueue items={[item({ reportCount: 2 })]} onChanged={() => {}} onReview={() => {}} />);
    expect(all).not.toContain('more report');
  });

  it('offers review, actioned and dismiss on a case under review', () => {
    expect(html).toContain('Review and act');
    expect(html).toContain('Mark actioned');
    expect(html).toContain('Dismiss');
  });
});
