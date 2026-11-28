/**
 * Scanner for the key-scope read seam (key-scope-reads.seam.test.ts), review #2849 r6 (widened in r7).
 *
 * A key (an MCP token or an OAuth grant) carries a drive scope: its `mcp_token_drives` rows; for OAuth, the stored
 * grant (the `scopes` column of the OAuth token tables, parsed into a ScopeSet whose `drives` it names); and, once
 * authenticated, the scope on the principal (`allowedDriveIds`, `driveScopes`). A read of that scope is where a key's
 * drive universe or role comes from, so it is where the owner bound ("no key reaches past its owner") must hold. This
 * scanner finds every such read, by the TypeScript AST, and names the function it sits in. It FAILS CLOSED:
 *
 *   - ANY reference to the `mcpTokenDrives` table (a query, a join, a column in a where, `${mcpTokenDrives}` in a sql
 *     template, `db.query.mcpTokenDrives`, `schema.mcpTokenDrives`, `x['mcpTokenDrives']`), writes included, or raw SQL
 *     reading `mcp_token_drives`;
 *   - a read of `.allowedDriveIds`, `.driveScopes` or `.mcpAllowedDriveIds` (the scope copied into an AI tool context),
 *     by dot, by string-literal brackets, or by destructuring; a relational `with: { driveScopes }`;
 *   - the OAuth store: `.scopes` of an OAuth token / code table, `.drives` of a scope set (`scopes.drives`,
 *     `auth.scopes['drives']`), and any reference to the parsers of stored scope strings;
 *   - any reference to the raw scope accessor `getAllowedDriveIds`.
 *
 * Names are resolved through import aliases (`import { mcpTokenDrives as t }`), namespace imports (`ns.mcpTokenDrives`)
 * and one-step const aliases (`const t = mcpTokenDrives`); a value holding a scope set under another name
 * (`const grant = auth.scopes`) and a destructure of its `drives` are followed too. The TYPE-based half
 * (key-scope-typed-scan.ts) catches what names cannot: a ScopeSet or an OAuth token row by its type.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './walk';
import { enclosingFunction, functionName } from './loosening-write-scan';

const SCOPE_TABLE = 'mcpTokenDrives';
const SCOPE_PROPERTIES = new Set(['allowedDriveIds', 'driveScopes', 'mcpAllowedDriveIds']);
/** Functions whose every reference is a scope read: the raw accessor and the parsers of stored OAuth scope strings. */
const SCOPE_FUNCTIONS = new Set(['getAllowedDriveIds', 'parseScopeList', 'scopeSetToDriveScopes']);
/** The OAuth tables whose `scopes` column is a key's stored grant. */
const OAUTH_SCOPE_TABLES = new Set(['oauthAccessTokens', 'oauthRefreshTokens', 'oauthAuthorizationCodes', 'oauthDeviceCodes']);
/** A receiver named like a scope set (`scopes`, `scopeSet`, `parsed.scopes`, `grantScopes`). */
const SCOPE_SET_NAME = /scope/i;

const RAW_SQL_READ = /\b(?:from|join)\s+"?mcp_token_drives\b/i;

export interface ScopeRead {
  file: string;
  line: number;
  /** The enclosing named function (`Class.method`, `owner.member`), or `<module>` at top level. */
  fn: string;
  /** e.g. `mcpTokenDrives`, `.allowedDriveIds`, `getAllowedDriveIds`, `oauthAccessTokens.scopes`, `scopes.drives`. */
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

/** The member name of `x.name` or `x['name']` (string literal), else null. */
function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    return node.argumentExpression.text;
  }
  return null;
}

/** `x` of `(x)`, `x as T`, `x!`, `<T>x`, `x satisfies T`. */
function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/** True when the identifier is a declaration or an import/export name, not a use. */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isNamespaceImport(p) || ts.isImportClause(p)) return true;
  if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === id) return true;
  if ((ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isPropertyAssignment(p) && p.name === id)) return true;
  if (ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) return p.name === id;
  return false;
}

/** Every key-scope read in one parsed source file. */
export function scanScopeReads(file: string, source: string): ScopeRead[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: ScopeRead[] = [];
  const at = (node: ts.Node, what: string) =>
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fn: nameOf(enclosingFunction(node)), what });

  // Import aliases and namespaces, then one-step const aliases of a tracked name.
  const alias = new Map<string, string>();
  const namespaces = new Set<string>();
  const tracked = (name: string) => name === SCOPE_TABLE || SCOPE_FUNCTIONS.has(name) || OAUTH_SCOPE_TABLES.has(name);
  const canonical = (expr: ts.Node): string | null => {
    if (ts.isIdentifier(expr)) return alias.get(expr.text) ?? expr.text;
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && namespaces.has(expr.expression.text)) return expr.name.text;
    return null;
  };
  // Values that hold a scope set under another name (`const grant = auth.scopes`), so `grant.drives` is seen too.
  const scopeHolders = new Set<string>();
  const isScopeSetExpr = (expr: ts.Expression): boolean => {
    const e = unwrap(expr);
    const name = memberName(e) ?? (ts.isIdentifier(e) ? e.text : null);
    return name !== null && (SCOPE_SET_NAME.test(name) || scopeHolders.has(name));
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isScopeSetExpr(node.initializer)) {
      scopeHolders.add(node.name.text);
    }
    if (ts.isImportSpecifier(node) && node.propertyName) alias.set(node.name.text, node.propertyName.text);
    if (ts.isNamespaceImport(node)) namespaces.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const target = canonical(node.initializer);
      if (target !== null && tracked(target)) alias.set(node.name.text, target);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const name = alias.get(node.text) ?? node.text;
      if (name === SCOPE_TABLE || SCOPE_FUNCTIONS.has(name)) at(node, name);
    }
    const member = memberName(node);
    if (member !== null && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const receiver = node.expression;
      if (member === SCOPE_TABLE || (namespaces.size > 0 && canonical(node) !== null && SCOPE_FUNCTIONS.has(canonical(node) as string))) {
        at(node, `.${member}`);
      } else if (SCOPE_PROPERTIES.has(member) && !isAssignmentTarget(node)) {
        at(node, `.${member}`);
      } else if (member === 'scopes' && OAUTH_SCOPE_TABLES.has(canonical(receiver) ?? '')) {
        at(node, `${canonical(receiver)}.scopes`);
      } else if (member === 'drives' && isScopeSetExpr(receiver)) {
        at(node, 'scopes.drives');
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
      if (keyText !== null && SCOPE_PROPERTIES.has(keyText)) at(node, `{ ${keyText} }`);
      // `const { drives } = auth.scopes` (or of a holder): the scope set's drives under a destructure.
      const decl = node.parent.parent;
      if (keyText === 'drives' && ts.isVariableDeclaration(decl) && decl.initializer && isScopeSetExpr(decl.initializer)) at(node, '{ drives } of scopes');
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
