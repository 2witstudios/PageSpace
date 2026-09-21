/**
 * Scanner for the drive access-gate seam guard (drive-access-gates.seam.test.ts).
 *
 * A SITE is one query of drive_members or one comparison involving a drive's ownerId. Each site is
 * attributed to the function that holds it (the nearest declaration above it), so the allowlist can
 * name and count sites per function: a second, ungated query planted beside an allowlisted one in
 * the same function changes that function's count, and one planted in any other function has no
 * allowlist entry at all. Validation is per site, never per file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './walk';

export type SiteKind = 'drive_members read' | 'drive ownerId comparison';

export interface Site {
  file: string;
  line: number;
  kind: SiteKind;
  /** The enclosing function's name (the nearest declaration above the site), or '<module>'. */
  anchor: string;
  text: string;
}

/** A read of drive_members: a select source, a join target, a relational query, or raw SQL. */
const DRIVE_MEMBERS_READ = [
  /\.from\(\s*driveMembers\b/g,
  /\.(?:inner|left|right|full)Join\(\s*driveMembers\b/g,
  /\bquery\.driveMembers\.find(?:First|Many)\b/g,
  /\b(?:FROM|JOIN)\s+"?drive_members"?\b/gi,
  // The table interpolated into a raw sql`` template: sql`select … from ${driveMembers} …`.
  /\$\{\s*driveMembers\s*\}/g,
];

/**
 * A comparison involving an ownerId: drizzle eq/ne on drives.ownerId (either side); a JS equality
 * (===, !==, ==, !=) with any identifier ending in ownerId on either side, so `drive.ownerId`, a
 * destructured `ownerId` and `driveOwnerId` all count; raw SQL `x."ownerId" =` / `= x."ownerId"`;
 * and the column interpolated into a sql`` template (`${drives.ownerId}`). Selecting the column
 * (`ownerId: drives.ownerId`) and writing it (`.set({ ownerId })`) are not comparisons. Non-drive
 * owners (agent sessions, conversations, env enrollments) match too and are allowlisted as such.
 */
const DRIVE_OWNER_COMPARE = [
  /\b(?:eq|ne)\(\s*drives\.ownerId\b/g,
  /\b(?:eq|ne)\([^,()]+,\s*drives\.ownerId\b/g,
  /\b[\w$]*[oO]wnerId\s*(?:===?|!==?)/g,
  /(?:===?|!==?)\s*[\w$.?[\]]*[oO]wnerId\b/g,
  /\b\w+\."ownerId"\s*=(?!=)/g,
  /=\s*\w+\."ownerId"/g,
  /\$\{\s*drives\.ownerId\s*\}/g,
];

/**
 * A line that starts a named function: a function declaration, a `const` bound to an arrow or a
 * function expression (its parameters closed on the line with `=>`, or left open for the next
 * lines), a class or object method, or an object property holding an arrow or an async function.
 */
const DECLARATION = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]+)?=>|\([^)]*$|[A-Za-z_$][\w$]*\s*=>|function\b)/,
  /^\s*(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*.+)?\{\s*$/,
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>\s*\{?\s*$/,
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*async\s*(?:\(|function\b)/,
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*function\b/,
  /^\s*(?:(?:public|private|protected|static|readonly)\s+)*async\s+([A-Za-z_$][\w$]*)\s*\(/,
];
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'with', 'else', 'do', 'try', 'new', 'typeof']);

/** Replace comments with spaces, keeping every offset and line number where it was. */
function stripComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)))
    .replace(/^(\s*)--[^\n]*/gm, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

/**
 * Offset of the `}` closing the body of the function declared on `lines[declIndex]`, or -1. The
 * body opens at the last `{` of the first signature line (the declaration line or one of the next
 * few, for a multi-line signature) that ends in `{` after a `)` or `=>`, so destructured parameters
 * and object return types are not taken for the body.
 */
function closingBrace(code: string, lines: string[], lineStarts: number[], declIndex: number): number {
  let open = -1;
  for (let i = declIndex; i < Math.min(lines.length, declIndex + 20); i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (line.endsWith('{') && /(?:\)|=>)/.test(line)) {
      open = lineStarts[i] + line.length - 1;
      break;
    }
  }
  if (open === -1) return -1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The innermost named function whose body encloses `offset`: walk up from the site's line to each
 * declaration and keep the first whose braces close after the site. A sibling closure declared
 * above the site (its body already closed) is skipped.
 */
function anchorAt(code: string, lines: string[], lineStarts: number[], lineIndex: number, offset: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    for (const pattern of DECLARATION) {
      const name = pattern.exec(lines[i])?.[1];
      if (!name || NOT_A_NAME.has(name)) continue;
      const end = closingBrace(code, lines, lineStarts, i);
      if (end === -1 || end > offset) return name;
    }
  }
  return '<module>';
}

/** Every site in one source text (repo-relative `file` is only a label). */
export function scanSource(file: string, source: string): Site[] {
  const code = stripComments(source);
  const lines = code.split('\n');
  const rawLines = source.split('\n');
  const lineStarts = lines.reduce<number[]>((starts, line, i) => [...starts, i === 0 ? 0 : starts[i - 1] + lines[i - 1].length + 1], []);
  const lineOf = (offset: number) => code.slice(0, offset).split('\n').length - 1;
  const sites: Site[] = [];
  const collect = (patterns: RegExp[], kind: SiteKind) => {
    const seen = new Set<number>();
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        const offset = match.index ?? 0;
        if (seen.has(offset)) continue;
        seen.add(offset);
        const line = lineOf(offset);
        sites.push({ file, line: line + 1, kind, anchor: anchorAt(code, lines, lineStarts, line, offset), text: rawLines[line].trim() });
      }
    }
  };
  collect(DRIVE_MEMBERS_READ, 'drive_members read');
  collect(DRIVE_OWNER_COMPARE, 'drive ownerId comparison');
  return sites.sort((a, b) => a.line - b.line);
}

export function scanFile(file: string): Site[] {
  return scanSource(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
}

/** Allowed sites of one function: an exact count per kind, and why each is not an access gate. */
export interface AllowedSites {
  reads?: number;
  ownerCompares?: number;
  reason: string;
}

export type AccessGateAllowlist = Readonly<Record<string, Readonly<Record<string, AllowedSites>>>>;

export interface GuardResult {
  /** "file › function: found {…}, allowed {…}" for every function whose sites differ from its entry. */
  mismatches: string[];
  /** Allowlist entries (file › function) that no longer hold any site. */
  stale: string[];
  /** Entries whose reason is too short to be one. */
  unexplained: string[];
}

const countKey = (s: Site) => (s.kind === 'drive_members read' ? 'reads' : 'ownerCompares');

export function checkSites(sites: readonly Site[], allowlist: AccessGateAllowlist): GuardResult {
  const found = new Map<string, { reads: number; ownerCompares: number; lines: string[] }>();
  for (const site of sites) {
    const key = `${site.file} › ${site.anchor}`;
    const entry = found.get(key) ?? { reads: 0, ownerCompares: 0, lines: [] };
    entry[countKey(site)] += 1;
    entry.lines.push(`    ${site.file}:${site.line} [${site.kind}] ${site.text}`);
    found.set(key, entry);
  }

  const mismatches: string[] = [];
  const allowedKeys = new Set<string>();
  const unexplained: string[] = [];
  for (const [file, functions] of Object.entries(allowlist)) {
    for (const [anchor, allowed] of Object.entries(functions)) {
      allowedKeys.add(`${file} › ${anchor}`);
      if (allowed.reason.trim().length < 20) unexplained.push(`${file} › ${anchor}`);
    }
  }
  for (const [key, actual] of found) {
    const [file, anchor] = key.split(' › ');
    const allowed = allowlist[file]?.[anchor];
    const want = { reads: allowed?.reads ?? 0, ownerCompares: allowed?.ownerCompares ?? 0 };
    if (actual.reads !== want.reads || actual.ownerCompares !== want.ownerCompares) {
      mismatches.push(
        `${key}: found ${JSON.stringify({ reads: actual.reads, ownerCompares: actual.ownerCompares })}, ` +
          `allowed ${JSON.stringify(want)}\n${actual.lines.join('\n')}`,
      );
    }
  }
  const stale = [...allowedKeys].filter((key) => !found.has(key)).sort();
  return { mismatches: mismatches.sort(), stale, unexplained };
}
