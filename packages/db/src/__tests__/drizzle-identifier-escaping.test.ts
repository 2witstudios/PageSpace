/**
 * Regression guard for CVE-2026-39356 / GHSA-gpj5-g38j-94v9 (#2134).
 *
 * drizzle-orm <= 0.45.1 quoted SQL identifiers without escaping embedded
 * delimiters, so any value reaching `sql.identifier()` could terminate the
 * quoted identifier and inject SQL. Fixed in 0.45.2.
 *
 * Two layers of protection here, both pure (no DB connection):
 *  1. Behavioural — compile hostile identifiers through PgDialect and assert
 *     every embedded double quote is doubled.
 *  2. Manifest floor — assert every `drizzle-orm` range in the monorepo (including
 *     the root `overrides` block, which governs transitive resolution) has a
 *     floor at or above the fixed version, so a future re-pin cannot silently
 *     reintroduce the vulnerable range.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

const compileIdentifier = (name: string): string =>
  dialect.sqlToQuery(sql`SELECT ${sql.identifier(name)}`).sql;

describe('sql.identifier escaping (CVE-2026-39356)', () => {
  const hostileNames = [
    'a"; DROP TABLE users; --',
    'a""b',
    '"',
    'position"',
  ];

  it.each(hostileNames)('should double every embedded quote in %j', (name) => {
    const compiled = compileIdentifier(name);

    expect(compiled).toBe(`SELECT "${name.replace(/"/g, '""')}"`);
  });

  it.each(hostileNames)('should keep %j inside a single quoted identifier', (name) => {
    const compiled = compileIdentifier(name);
    const body = compiled.slice('SELECT "'.length, -1);

    // Every quote inside the identifier body must be part of an escaped pair —
    // an odd-length run of quotes would terminate the identifier early.
    for (const run of body.match(/"+/g) ?? []) {
      expect(run.length % 2).toBe(0);
    }
  });

  it('should leave a plain identifier untouched', () => {
    expect(compileIdentifier('position')).toBe('SELECT "position"');
  });
});

/** Minimum drizzle-orm version carrying the CVE-2026-39356 fix. */
const FIXED_VERSION = '0.45.2';

/** Pure: does a semver range's lower bound reach `floor`? Returns false for anything unparseable. */
const meetsFloor = (range: string, floor: string): boolean => {
  const match = /^[\^~]?(\d+)\.(\d+)\.(\d+)/.exec(range.trim());
  if (!match) return false;

  const floorMatch = /^(\d+)\.(\d+)\.(\d+)/.exec(floor);
  if (!floorMatch) return false;

  for (let i = 1; i <= 3; i++) {
    const actual = Number(match[i]);
    const required = Number(floorMatch[i]);
    if (actual > required) return true;
    if (actual < required) return false;
  }
  return true;
};

describe('meetsFloor', () => {
  it.each([
    ['^0.45.2', true],
    ['0.45.2', true],
    ['~0.45.2', true],
    ['^0.45.3', true],
    ['^0.46.0', true],
    ['^1.0.0', true],
    ['  ^0.45.2  ', true],
    ['^0.45.1', false],
    ['^0.44.9', false],
    ['^0.32.2', false],
    ['workspace:*', false],
    ['', false],
  ])('should rate %j against 0.45.2 as %s', (range, expected) => {
    expect(meetsFloor(range, FIXED_VERSION)).toBe(expected);
  });

  it('should reject an unparseable floor', () => {
    expect(meetsFloor('^0.45.2', 'latest')).toBe(false);
  });
});

const repoRoot = path.resolve(__dirname, '../../../..');

const manifestCache = new Map<string, Record<string, Record<string, string> | undefined>>();

const readManifest = (relPath: string): Record<string, Record<string, string> | undefined> => {
  const cached = manifestCache.get(relPath);
  if (cached) return cached;

  const manifest = JSON.parse(readFileSync(path.join(repoRoot, relPath), 'utf8'));
  manifestCache.set(relPath, manifest);
  return manifest;
};

/** Every place a drizzle-orm range is declared: [manifest, key holding the dependency map]. */
const DRIZZLE_RANGE_SITES: ReadonlyArray<[string, string]> = [
  ['package.json', 'devDependencies'],
  ['package.json', 'overrides'],
  ['packages/db/package.json', 'dependencies'],
  ['packages/lib/package.json', 'dependencies'],
  ['apps/control-plane/package.json', 'dependencies'],
];

describe('drizzle-orm version floor across the monorepo', () => {
  it.each(DRIZZLE_RANGE_SITES)('should pin %s → %s past the CVE fix', (manifest, section) => {
    const range = readManifest(manifest)[section]?.['drizzle-orm'];

    expect(range).toBeDefined();
    expect(meetsFloor(range as string, FIXED_VERSION)).toBe(true);
  });
});
