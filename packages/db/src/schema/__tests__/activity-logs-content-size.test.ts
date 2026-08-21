/**
 * `activity_logs_content_size_limit` guards the INLINE snapshot, not the
 * offloaded blob.
 *
 * The regression this pins (prod, 2026-08-21): `contentSize` describes whatever
 * `contentRef` points at in the blob store, which is legitimately larger than
 * the 1MB inline budget. Bounding it unconditionally made every page write
 * whose PREVIOUS content exceeded 1MB fail — and because the activity insert
 * shares the caller's mutation transaction (`logActivityWithTx`), the CHECK
 * violation rolled back the user's edit, not merely its audit row. Sheet pages
 * at ~1.02MB retried in a loop and never saved.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { activityLogs } from '../monitoring';

const config = getTableConfig(activityLogs);
const CONSTRAINT = 'activity_logs_content_size_limit';

/**
 * The CHECK's predicate flattened to text. Chunks interleave raw SQL fragments
 * with live column objects (circular, so unstringifiable) — reducing each to
 * its `name` makes "which columns is this stated over" assertable.
 */
function checkSql(name: string): string {
  const constraint = config.checks.find((candidate) => candidate.name === name);
  expect(constraint, `expected a CHECK named ${name}`).toBeDefined();
  const chunks = (constraint!.value as unknown as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      const named = chunk as { name?: unknown; value?: unknown };
      if (typeof named.name === 'string') return named.name;
      if (Array.isArray(named.value)) return named.value.join('');
      return '';
    })
    .join(' ');
}

describe('activity_logs content size CHECK', () => {
  it('exempts offloaded content by stating the predicate over contentRef', () => {
    const sql = checkSql(CONSTRAINT);

    // Without contentRef in the predicate there is no exemption at all, and the
    // 1MB bound applies to blob sizes it was never meant to describe.
    expect(sql).toContain('contentRef');
    expect(sql).toContain('contentSize');
    expect(sql).toContain('1048576');
  });

  it('still bounds inline snapshots, i.e. the exemption is not unconditional', () => {
    const sql = checkSql(CONSTRAINT);

    // A blanket relaxation (dropping the constraint, or `contentSize IS NOT
    // NULL OR ...`) would also pass the assertion above. The bound must remain
    // reachable for rows with no blob behind them.
    expect(sql).toMatch(/contentRef\s+IS NOT NULL/);
    expect(sql).toMatch(/contentSize\s+<=\s+1048576/);
  });

  it('ships a migration that replaces the unconditional constraint', () => {
    const dir = path.resolve(__dirname, '../../../drizzle');
    const sql = fs
      .readdirSync(dir)
      // `readdirSync` returns DIRECTORY order, which is sorted on APFS but hash
      // order on ext4 — what CI runs. Without this the "last definition wins"
      // reading below can land on the wrong migration.
      .sort()
      .filter((file) => file.endsWith('.sql'))
      .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');

    // The LAST definition of the constraint in migration order is what a
    // freshly-migrated database ends up with.
    const definitions = [
      ...sql.matchAll(
        new RegExp(`ADD CONSTRAINT "${CONSTRAINT}" CHECK \\(([^;]*?)\\)\\s*;`, 'g')
      ),
    ];
    expect(definitions.length).toBeGreaterThan(0);
    expect(definitions[definitions.length - 1]![1]).toContain('contentRef');
  });
});
