/**
 * A reporter's words may be abusive, carry markup or carry links. The queue must
 * show them as plain text: escaped, and never turned into an anchor.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));

import { ReportQueue } from '../report-queue';
import { ReportedHashNotice } from '../target-panel';
import type { ReportedCaseSummary } from '@/lib/content/report-summary';

const item = (overrides: Partial<ReportedCaseSummary> = {}): ReportedCaseSummary => ({
  case: {
    id: 'case-r', targetType: 'page', targetId: 'page_1', contentHash: null, status: 'reported', category: 'csam', reason: null,
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', actorUserId: null, evidencePreserved: false, otherObjectsPreserved: 0,
    progress: { kind: null, steps: [], resumable: false, resweepable: false, restorable: false } as unknown as ReportedCaseSummary['case']['progress'],
    references: null, skippedDrives: [],
  },
  reportCount: 3,
  scan: null,
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

  it('will not close a case until every report on it has been shown', () => {
    const closeButtons = (markup: string) => [...markup.matchAll(/<button[^>]*>(Mark actioned|Dismiss)<\/button>/g)].map((m) => m[0]);
    const partial = closeButtons(html);
    expect(partial).toHaveLength(2);
    for (const button of partial) expect(button).toMatch(/disabled=""/);
    expect(html).toContain('Show every report before closing this case.');

    const all = renderToStaticMarkup(<ReportQueue items={[item({ reportCount: 2 })]} onChanged={() => {}} onReview={() => {}} />);
    const full = closeButtons(all);
    expect(full).toHaveLength(2);
    for (const button of full) expect(button).not.toMatch(/disabled=""/);
  });

  it('shows a flagged-scan case with no reports by its score and mode, never a file', () => {
    const flagged = renderToStaticMarkup(
      <ReportQueue
        items={[item({ reportCount: 0, reports: [], scan: { provider: 'hive', category: 'csam', score: 0.97, mode: 'shadow', flaggedAt: '2026-11-12T00:00:00.000Z' } })]}
        onChanged={() => {}}
        onReview={() => {}}
      />,
    );
    expect(flagged).toContain('Flagged by publish scan');
    expect(flagged).toContain('0.970');
    expect(flagged).toContain('shadow mode');
    expect(flagged).toContain('it was published');
    expect(flagged).not.toContain('0 reports');
    expect(flagged).not.toMatch(/<(img|a|video)[\s>]/);
    expect(flagged).toContain('Dismiss');
  });
});

describe('ReportedHashNotice', () => {
  const reported = 'a'.repeat(64);
  it('says the content is still what was reported', () => {
    const html = renderToStaticMarkup(<ReportedHashNotice reportedHash={reported} currentHash={reported} onLookUp={() => {}} />);
    expect(html).toContain('matches the content that was reported');
  });

  it('warns when the content changed since it was reported, names both hashes, and offers the reported one', () => {
    const html = renderToStaticMarkup(<ReportedHashNotice reportedHash={reported} currentHash={'b'.repeat(64)} onLookUp={() => {}} />);
    expect(html).toContain('changed since it was reported');
    expect(html).toContain(reported);
    expect(html).toContain('b'.repeat(64));
    expect(html).toContain('A global takedown here blocks the current content');
    expect(html).toContain('Look up the reported content');
  });

  it('says nothing for a case that recorded no hash', () => {
    expect(renderToStaticMarkup(<ReportedHashNotice reportedHash={null} currentHash={'b'.repeat(64)} onLookUp={() => {}} />)).toBe('');
  });
});
