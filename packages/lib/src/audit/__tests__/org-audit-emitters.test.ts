/**
 * EMITTER → CATALOG (Spec AUD-1; Review 3+4 P2-10). An org sees only the event types its catalog lists
 * (org-audit-query-core.ts), so an org.* type that code writes but the catalog omits is invisible to the org. Two
 * types went missing that way (org.compute.reattributed, org.app.unparked) because the coverage suite only checked
 * the other direction (every catalog type has an emitter). This guard fails whenever:
 *
 * - the SecurityEventType union (every type the audit chain accepts, so every type any code can write) has an org.*
 *   member the catalog does not list, or
 * - any source file names an org.* event type literal the catalog does not list.
 *
 * Static on purpose: it reads the source, so it needs no database and runs in the unit suite.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ORG_AUDIT_EVENT_TYPES } from '../org-audit-query-core';

const REPO_ROOT = resolve(__dirname, '../../../../..');
const UNION_FILE = 'packages/db/src/schema/security-audit.ts';
const ROOTS = ['packages', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '__tests__', 'drizzle', 'android', 'ios', 'build', 'out']);

/** `| 'org.member.joined'` lines of the SecurityEventType union. */
const UNION_MEMBER = /^\s*\|\s*'(org\.[a-z_]+(?:\.[a-z_]+)*)'/gm;
/** A quoted org.* event type literal anywhere in code. */
const ORG_TYPE_LITERAL = /['"`](org\.[a-z_]+(?:\.[a-z_]+)*)['"`]/g;

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const matchesOf = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map((m) => m[1]);
const catalog = new Set<string>(ORG_AUDIT_EVENT_TYPES);

describe('every org event that can be written is in the org audit catalog', () => {
  it('AUD-1 (partial) every org.* member of SecurityEventType (all a writer can emit) is catalogued, so the org sees it', () => {
    const union = matchesOf(UNION_MEMBER, readFileSync(join(REPO_ROOT, UNION_FILE), 'utf8'));
    expect(union.length).toBeGreaterThan(30);
    expect(union.filter((type) => !catalog.has(type))).toEqual([]);
  });

  it('AUD-1 (partial) every org.* event type named in source code is catalogued', () => {
    const missing = new Map<string, string[]>();
    let named = 0;
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        for (const type of matchesOf(ORG_TYPE_LITERAL, stripComments(readFileSync(file, 'utf8')))) {
          named += 1;
          if (!catalog.has(type)) missing.set(type, [...(missing.get(type) ?? []), rel]);
        }
      }
    }
    // The emitters, the union and the catalog name dozens; a scan that finds none guards nothing.
    expect(named).toBeGreaterThan(50);
    expect(Object.fromEntries(missing)).toEqual({});
  });

  it('the patterns match the shapes they exist to catch (so they cannot pass by matching nothing)', () => {
    expect(matchesOf(ORG_TYPE_LITERAL, "await recordOrgAuditEvent({ eventType: 'org.compute.reattributed' })")).toEqual(['org.compute.reattributed']);
    expect(matchesOf(ORG_TYPE_LITERAL, 'audit(claim, "org.guest.declined", actor)')).toEqual(['org.guest.declined']);
    expect(matchesOf(ORG_TYPE_LITERAL, "eventType: 'org.created'")).toEqual(['org.created']);
    expect(matchesOf(UNION_MEMBER, "export type T =\n  | 'org.created'\n  | 'org.app.unparked';")).toEqual(['org.created', 'org.app.unparked']);
    expect(matchesOf(ORG_TYPE_LITERAL, 'const host = org.example.com; // org.member.joined in a comment')).toEqual([]);
  });
});
