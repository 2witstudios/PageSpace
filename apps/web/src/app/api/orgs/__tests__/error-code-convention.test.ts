/**
 * The ONE error convention of the org, wallet, seat and policy routes (Review 3+4 P2-11(a)):
 * every error body is `{ error, code, ...extras }`, the code is one the registry lists, and
 * `reason` is never the machine key. A static scan of the route sources, so a new route or a new
 * refusal cannot ship another shape. (The orgs-dark 404 goes through `orgsDisabledResponse`, not
 * a literal here, and is deliberately bare.)
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ORG_API_ERROR_CODES } from '@pagespace/lib/organizations/api-error-codes';

const API = join(__dirname, '..', '..');
const ROOTS = [join(API, 'orgs'), join(API, 'drives', '[driveId]', 'wallet'), join(API, 'wallets')];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

/** Every `NextResponse.json(...)` argument list in `source`, with its line. */
function jsonCalls(source: string): { line: number; args: string }[] {
  const calls: { line: number; args: string }[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('NextResponse.json(', from);
    if (at < 0) return calls;
    let i = at + 'NextResponse.json('.length;
    const start = i;
    let depth = 1;
    let quote: string | null = null;
    while (depth > 0 && i < source.length) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '\'' || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    calls.push({ line: source.slice(0, at).split('\n').length, args: source.slice(start, i - 1).replace(/\s+/g, ' ') });
    from = i;
  }
}

const isErrorBody = (args: string): boolean => /^\{ ?error\b/.test(args.trim());

const files = ROOTS.flatMap(routeFiles);

describe('org, wallet, seat and policy route error bodies', () => {
  it('the scan reaches every route in scope', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('UI-7 (partial) every error body carries a machine `code` and never a `reason` key', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const call of jsonCalls(readFileSync(file, 'utf8'))) {
        if (!isErrorBody(call.args)) continue;
        const body = call.args.slice(0, call.args.indexOf('}') + 1);
        if (/\breason:/.test(body) || !/\bcode\b/.test(body)) offenders.push(`${relative(API, file)}:${call.line} ${body}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('UI-7 (partial) every literal code is one the registry lists, so the UI can map it to copy', () => {
    const known = new Set<string>(ORG_API_ERROR_CODES);
    const unknown: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\bcode: '([a-z_]+)'/g)) {
        if (!known.has(match[1])) unknown.push(`${relative(API, file)} ${match[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
