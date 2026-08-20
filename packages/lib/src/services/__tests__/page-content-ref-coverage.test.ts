import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Reclaim is only as safe as its reference count is complete: a `contentRef`
 * column added to a new table would make `deletePageContent` see zero
 * references for a blob that is still in use, and delete it.
 *
 * `CONTENT_REF_SOURCES` in page-content-store.ts cannot be enumerated from the
 * schema at runtime, so this guard reads the schema source instead. When it
 * fails, add the new table to CONTENT_REF_SOURCES and then to this list.
 */
const COUNTED_TABLES = [
  { file: 'versioning.ts', table: 'pageVersions' },
  { file: 'monitoring.ts', table: 'activityLogs' },
];

const schemaDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../db/src/schema'
);

function filesDeclaringContentRef(): string[] {
  return readdirSync(schemaDir)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => /^\s*contentRef:\s*text\(/m.test(readFileSync(join(schemaDir, name), 'utf8')));
}

describe('content ref reclaim coverage', () => {
  it('every schema file with a contentRef column is counted by the reclaim path', () => {
    expect(filesDeclaringContentRef().sort()).toEqual(
      COUNTED_TABLES.map((entry) => entry.file).sort()
    );
  });

  it('names the tables page-content-store counts', () => {
    const store = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../page-content-store.ts'),
      'utf8'
    );
    for (const { table } of COUNTED_TABLES) {
      expect(store).toContain(`${table}.contentRef`);
    }
  });
});
