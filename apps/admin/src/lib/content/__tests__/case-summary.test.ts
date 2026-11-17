import { describe, it, expect } from 'vitest';
import type { ContentCase } from '@pagespace/db/schema/content-safety';
import { toCaseSummary } from '../case-summary';

const row = (snapshot: ContentCase['snapshot']): ContentCase => ({
  id: 'case-1',
  targetType: 'content_hash',
  targetId: 'a'.repeat(64),
  contentHash: 'a'.repeat(64),
  status: 'actioned',
  category: 'csam',
  reporterUserId: null,
  reporterContact: null,
  reason: 'reported',
  snapshot,
  steps: [],
  createdAt: new Date('2026-11-12T00:00:00.000Z'),
  updatedAt: new Date('2026-11-12T00:00:00.000Z'),
});

describe('toCaseSummary evidencePreserved', () => {
  it('is true for a case with its primary evidence copy', () => {
    expect(toCaseSummary(row({ evidenceKey: 'cases/case-1/h/original' })).evidencePreserved).toBe(true);
  });

  it('is false for a case whose only copies are of bytes that were not the hashed content, which are counted apart', () => {
    const summary = toCaseSummary(row({ additionalEvidenceKeys: ['cases/case-1/h/original.abc', 'cases/case-1/h/original.def'] }));
    expect(summary.evidencePreserved).toBe(false);
    expect(summary.otherObjectsPreserved).toBe(2);
  });

  it('is false for a case with no copy at all', () => {
    expect(toCaseSummary(row({ additionalEvidenceKeys: [] }))).toMatchObject({ evidencePreserved: false, otherObjectsPreserved: 0 });
    expect(toCaseSummary(row(null))).toMatchObject({ evidencePreserved: false, otherObjectsPreserved: 0 });
  });

  it('never returns the evidence keys themselves', () => {
    const json = JSON.stringify(toCaseSummary(row({ evidenceKey: 'cases/case-1/h/original', additionalEvidenceKeys: ['cases/case-1/h/original.abc'] })));
    expect(json).not.toContain('cases/case-1/');
  });
});
