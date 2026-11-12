import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { contentBlocks, contentScans, contentCases, contentSiteHolds } from '../content-safety';

const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).columns.map((c) => c.name).sort();

describe('content-safety schema', () => {
  it('content_blocks is keyed by content hash', () => {
    const config = getTableConfig(contentBlocks);
    expect(config.name).toBe('content_blocks');
    expect(config.columns.find((c) => c.primary)?.name).toBe('content_hash');
    expect(columnNames(contentBlocks)).toEqual(
      ['case_id', 'category', 'content_hash', 'created_at', 'created_by', 'source'],
    );
  });

  it('content_scans is keyed by content hash', () => {
    const config = getTableConfig(contentScans);
    expect(config.name).toBe('content_scans');
    expect(config.columns.find((c) => c.primary)?.name).toBe('content_hash');
    expect(columnNames(contentScans)).toEqual(
      ['content_hash', 'provider', 'provider_version', 'scanned_at', 'scores', 'verdict'],
    );
  });

  it('content_cases carries target, reporter, snapshot and resumable steps', () => {
    const config = getTableConfig(contentCases);
    expect(config.name).toBe('content_cases');
    expect(columnNames(contentCases)).toEqual([
      'category',
      'content_hash',
      'created_at',
      'id',
      'reason',
      'reporter_contact',
      'reporter_user_id',
      'snapshot',
      'status',
      'steps',
      'target_id',
      'target_type',
      'updated_at',
    ]);
  });

  it('content_site_holds is keyed by drive, one hold per drive', () => {
    const config = getTableConfig(contentSiteHolds);
    expect(config.name).toBe('content_site_holds');
    expect(config.columns.find((c) => c.primary)?.name).toBe('drive_id');
    expect(columnNames(contentSiteHolds)).toEqual(
      ['case_id', 'created_at', 'created_by', 'drive_id', 'source', 'user_id'],
    );
  });

  // Legal preservation: a case, block or verdict must outlive the user, page and
  // drive it names. Any foreign key here would let user erasure (or a page/drive
  // delete) cascade into — or be blocked by — the evidence record.
  it.each([
    ['content_blocks', contentBlocks],
    ['content_scans', contentScans],
    ['content_cases', contentCases],
    ['content_site_holds', contentSiteHolds],
  ])('%s has no foreign keys, so erasure cannot reach it', (_name, table) => {
    expect(getTableConfig(table).foreignKeys).toHaveLength(0);
  });
});
