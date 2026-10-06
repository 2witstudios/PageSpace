/**
 * Scanner for the key-scope read seam (key-scope-reads.seam.test.ts), review #2849 r6.
 *
 * A key (an MCP token or an OAuth grant) carries a drive scope: its `mcp_token_drives` rows, and, once authenticated,
 * the scope on the principal (`allowedDriveIds`, `driveScopes`; for OAuth that IS the stored grant, parsed). A read of
 * that scope is where a key's drive universe or role comes from, so it is where the owner bound ("no key reaches past
 * its owner") must hold. This scanner finds every such read, by the TypeScript AST, and names the function it sits in:
 *
 *   - a query of `mcpTokenDrives` (`.from` / a join / `db.query.mcpTokenDrives` / a relational `with: { driveScopes }`)
 *     or raw SQL reading `mcp_token_drives`;
 *   - a property read of `.allowedDriveIds`, `.driveScopes` or `.mcpAllowedDriveIds` (the scope as copied into an AI
 *     tool context), or a destructuring of one;
 *   - a call of `getAllowedDriveIds` (the raw scope accessor).
 *
 * Writes of `mcpTokenDrives` (insert / update / delete) are the loosening seam's (loosening-write-scan.ts), not here.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './walk';
import { enclosingFunction, functionName } from './loosening-write-scan';

const SCOPE_TABLE = 'mcpTokenDrives';
const SCOPE_PROPERTIES = ['allowedDriveIds', 'driveScopes', 'mcpAllowedDriveIds'] as const;
const RAW_SCOPE_ACCESSOR = 'getAllowedDriveIds';

const READ_CALLS = new Set(['from', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin']);
const RAW_SQL_READ = /\b(?:from|join)\s+"?mcp_token_drives\b/i;

export interface ScopeRead {
  file: string;
  line: number;
  /** The enclosing named function (`Class.method`, `owner.member`), or `<module>` at top level. */
  fn: string;
  /** e.g. `from(mcpTokenDrives)`, `.allowedDriveIds`, `getAllowedDriveIds()`, `raw sql`. */
  what: string;
}

const nameOf = (fnNode: ts.Node | null): string => (fnNode ? (functionName(fnNode) ?? '<anonymous>') : '<module>');

/** True when `node` is the target of an assignment (`x.allowedDriveIds = …`), which writes the scope, not reads it. */
function isAssignmentTarget(node: ts.Node): boolean {
  const p = node.parent;
  return !!p && ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/** True when this `driveScopes:` property sits in a relational query's `with: { … }` object. */
function isRelationalWith(prop: ts.PropertyAssignment): boolean {
  const obj = prop.parent;
  const holder = obj?.parent;
  return !!holder && ts.isPropertyAssignment(holder) && ts.isIdentifier(holder.name) && holder.name.text === 'with';
}

/** Every key-scope read in one parsed source file. */
export function scanScopeReads(file: string, source: string): ScopeRead[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: ScopeRead[] = [];
  const at = (node: ts.Node, what: string) =>
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fn: nameOf(enclosingFunction(node)), what });
  const props = new Set<string>(SCOPE_PROPERTIES);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (ts.isPropertyAccessExpression(callee) && READ_CALLS.has(callee.name.text) && arg && ts.isIdentifier(arg) && arg.text === SCOPE_TABLE) {
        at(node, `${callee.name.text}(${SCOPE_TABLE})`);
      }
      if ((ts.isIdentifier(callee) && callee.text === RAW_SCOPE_ACCESSOR) || (ts.isPropertyAccessExpression(callee) && callee.name.text === RAW_SCOPE_ACCESSOR)) {
        at(node, `${RAW_SCOPE_ACCESSOR}()`);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === SCOPE_TABLE && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') {
        at(node, `query.${SCOPE_TABLE}`);
      } else if (props.has(name) && !isAssignmentTarget(node)) {
        at(node, `.${name}`);
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) && props.has(key.text)) at(node, `{ ${key.text} }`);
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'driveScopes' && isRelationalWith(node)) {
      at(node, 'with: { driveScopes }');
    }
    if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node)) && RAW_SQL_READ.test(node.getText(sf))) {
      at(node, 'raw sql');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function scanScopeReadsInFile(file: string): ScopeRead[] {
  return scanScopeReads(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
}
