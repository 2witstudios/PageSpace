/**
 * Scanner for the D-OW-33 loosening-write seam (org-lapse-loosening.seam.test.ts).
 *
 * A "loosening write" is any insert or update of a table whose rows grant access in a drive or an org:
 * drive members, page grants, share links, drive roles, drive agents, org members and org invitations;
 * an insert of a pending invitation or a custom domain; an update of `pages` that sets `isPrivate` or `driveId`; and
 * an update of `drives` that moves its lead (ownerId), its org (orgId) or its visibility
 * (orgVisibility). A delete only ever removes access, so it is not a loosening write.
 *
 * The scanner parses each file with the TypeScript compiler (not a line regex), so it can name the
 * function that ENCLOSES each write: the seam's ledger is keyed `file#function`, and a ledgered
 * function either calls the lapse guard itself, names the function that does, or records why it is
 * exempt.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './walk';

/** Tables whose inserted or updated rows can grant access. */
export const ACCESS_TABLES = [
  'driveMembers',
  'pagePermissions',
  'driveShareLinks',
  'pageShareLinks',
  'driveRoles',
  'driveAgentMembers',
  'orgMembers',
  'orgInvitations',
  'mcpTokenDrives',
] as const;

/**
 * Tables where only an INSERT can widen access: a pending drive or page invitation (a token that admits whoever
 * accepts it) and a custom domain (published content on a new host). Their updates consume, verify or suspend.
 */
export const INSERT_ONLY_TABLES = ['pendingInvites', 'pendingPageInvites', 'customDomains'] as const;

/** The `drives` columns whose update can widen who reaches the drive. */
export const DRIVE_ACCESS_COLUMNS = ['ownerId', 'orgId', 'orgVisibility'] as const;

/**
 * The `pages` columns whose update can widen who reads a page: `isPrivate` (made readable by the whole drive) and
 * `driveId` (moved into another drive's audience). Only a LITERAL key is matched: the generic page mutation's
 * non-literal update is ledgered by its callers (the PATCH route and rollback guard it).
 */
export const PAGE_ACCESS_COLUMNS = ['isPrivate', 'driveId'] as const;

/** A raw-SQL write of an access table (snake_case table names). */
const RAW_SQL_WRITE =
  /\b(?:insert\s+into|update)\s+"?(?:drive_members|page_permissions|drive_share_links|page_share_links|drive_roles|drive_agent_members|org_members|org_invitations|mcp_token_drives)\b/i;

export interface LooseningWrite {
  file: string;
  line: number;
  /** The enclosing named function (`Class.method` for a method), or `<module>` at top level. */
  fn: string;
  /** e.g. `insert(driveMembers)`, `update(drives).set({ orgVisibility })`, `raw sql`. */
  what: string;
}

/** The bare name a function-like node is known by, or null for an anonymous callback. */
function baseName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
    const p = node.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
    if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  }
  return null;
}

/**
 * The name a function-like node is ledgered under: `Class.method` for a class method, `owner.member` for a member of
 * an object literal (a repository object, an AI tool's `execute`), the bare name otherwise; null when anonymous.
 */
export function functionName(node: ts.Node): string | null {
  const base = baseName(node);
  if (base === null) return null;
  if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent)) {
    return node.parent.name ? `${node.parent.name.text}.${base}` : base;
  }
  const obj = ts.isMethodDeclaration(node) ? node.parent : node.parent && ts.isPropertyAssignment(node.parent) ? node.parent.parent : null;
  if (obj && ts.isObjectLiteralExpression(obj)) {
    let cur: ts.Node | undefined = obj.parent;
    while (cur && !ts.isSourceFile(cur) && !ts.isFunctionLike(cur)) {
      if ((ts.isVariableDeclaration(cur) || ts.isPropertyAssignment(cur)) && (ts.isIdentifier(cur.name) || ts.isStringLiteral(cur.name))) {
        return `${cur.name.text}.${base}`;
      }
      cur = cur.parent;
    }
  }
  return base;
}

/** The nearest NAMED enclosing function; anonymous callbacks (tx => …) belong to the function around them. */
export function enclosingFunction(node: ts.Node): ts.Node | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionLike(cur) && functionName(cur) !== null) return cur;
    cur = cur.parent;
  }
  return null;
}

function nameOf(fnNode: ts.Node | null): string {
  return fnNode ? (functionName(fnNode) ?? '<anonymous>') : '<module>';
}

/** The keys of the object literal passed to the `.set(...)` chained after `update(drives)`, if any. */
function setKeysAfter(updateCall: ts.CallExpression): string[] | null {
  let cur: ts.Node = updateCall;
  while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.parent && ts.isCallExpression(cur.parent.parent)) {
    const access = cur.parent;
    const call = cur.parent.parent;
    if (access.name.text === 'set') {
      const arg = call.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        return arg.properties.flatMap((p) => {
          if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name)) return [p.name.text];
          if (ts.isSpreadAssignment(p)) return ['...'];
          return [];
        });
      }
      return ['<non-literal>'];
    }
    cur = call;
  }
  return null;
}

/** Every loosening write in one parsed source file. */
export function scanSource(file: string, source: string): LooseningWrite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: LooseningWrite[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const tables = new Set<string>(ACCESS_TABLES);
  const insertOnly = new Set<string>(INSERT_ONLY_TABLES);
  const driveCols = new Set<string>(DRIVE_ACCESS_COLUMNS);
  const pageCols = new Set<string>(PAGE_ACCESS_COLUMNS);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const arg = node.arguments[0];
      if ((method === 'insert' || method === 'update') && arg && ts.isIdentifier(arg)) {
        if (tables.has(arg.text) || (method === 'insert' && insertOnly.has(arg.text))) {
          out.push({ file, line: lineOf(node), fn: nameOf(enclosingFunction(node)), what: `${method}(${arg.text})` });
        } else if (arg.text === 'pages' && method === 'update') {
          const keys = setKeysAfter(node);
          const hit = keys === null ? [] : keys.filter((k) => pageCols.has(k));
          if (hit.length > 0) {
            out.push({ file, line: lineOf(node), fn: nameOf(enclosingFunction(node)), what: `update(pages).set({ ${hit.join(', ')} })` });
          }
        } else if (arg.text === 'drives' && method === 'update') {
          const keys = setKeysAfter(node);
          const hit = keys === null ? [] : keys.filter((k) => driveCols.has(k) || k === '...' || k === '<non-literal>');
          if (hit.length > 0) {
            out.push({ file, line: lineOf(node), fn: nameOf(enclosingFunction(node)), what: `update(drives).set({ ${hit.join(', ')} })` });
          }
        }
      }
    }
    if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node)) && RAW_SQL_WRITE.test(node.getText(sf))) {
      out.push({ file, line: lineOf(node), fn: nameOf(enclosingFunction(node)), what: 'raw sql' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function scanFile(file: string): LooseningWrite[] {
  return scanSource(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
}

/**
 * The source text of each function named `fn` in `file` (a file may hold more than one function of
 * the same name, e.g. a method and a helper; their texts are joined).
 */
export function functionText(file: string, fn: string): string | null {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && functionName(node) === fn) texts.push(node.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return texts.length > 0 ? texts.join('\n') : null;
}

/** Code with comments stripped, so a guard named only in a comment does not count. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
