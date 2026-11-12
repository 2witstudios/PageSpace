import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { contentBlocks, contentScans, contentCases } from '../content-safety';

const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).columns.map((c) => c.name).sort();

describe('content-safety schema', () => {
  it('content_blocks is keyed by content hash', () => {
    const config = getTableConfig(contentBlocks);
    expect(config.name).toBe('content_blocks');
    expect(config.columns.find((c) => c.primary)?.name).toBe('content_hash');
    expect(columnNames(contentBlocks)).toEqual(
      ['case_id', 'category', 'content_hash', 'created_at', 'created_by', 'source'].sort(),
    );
  });

  it('content_scans is keyed by content hash', () => {
    const config = getTableConfig(contentScans);
    expect(config.name).toBe('content_scans');
    expect(config.columns.find((c) => c.primary)?.name).toBe('content_hash');
    expect(columnNames(contentScans)).toEqual(
      ['content_hash', 'provider', 'provider_version', 'scanned_at', 'scores', 'verdict'].sort(),
    );
  });

  it('content_cases carries target, reporter, snapshot and resumable steps', () => {
    const config = getTableConfig(contentCases);
    expect(config.name).toBe('content_cases');
    expect(columnNames(contentCases)).toEqual(
      [
        'id',
        'target_type',
        'target_id',
        'content_hash',
        'status',
        'category',
        'reporter_user_id',
        'reporter_contact',
        'reason',
        'snapshot',
        'steps',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  // Legal preservation: a case, block or verdict must outlive the user, page and
  // drive it names. Any foreign key here would let user erasure (or a page/drive
  // delete) cascade into — or be blocked by — the evidence record.
  it.each([
    ['content_blocks', contentBlocks],
    ['content_scans', contentScans],
    ['content_cases', contentCases],
  ])('%s has no foreign keys, so erasure cannot reach it', (_name, table) => {
    expect(getTableConfig(table).foreignKeys).toHaveLength(0);
  });
});
