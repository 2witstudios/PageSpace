/**
 * Scanner for the POL-1 policy seam (policy-column.seam.test.ts).
 *
 * "Policies are … read through one function; no route reads the org row directly." The stored column is
 * `organizations.policies`. This scanner parses every source file with the TypeScript compiler (not a line regex) and
 * FAILS CLOSED on the organizations TABLE, not just the column: every use of the table object must be one of a few
 * shapes that provably name their columns, and anything else is reported.
 *
 * A use of the table (the imported `organizations`, any alias it is imported or re-bound under, `schema.organizations`
 * through a namespace import) is allowed only as:
 *   - a named column, `organizations.id` (never `.policies`, never a `$`/`_` internal such as `$inferSelect`);
 *   - the table of `from()` / a join, when the chain's `select({ … })` names every output as a column expression
 *     (a bare `select()`, a spread, or a whole table as a value is a whole-row read);
 *   - the target of `insert()` / `update()` / `delete()`, unless the chain ends in a bare `.returning()`;
 *   - the initializer of a local alias (`const t = organizations`), whose own uses are then checked the same way.
 * Anything else — `getTableColumns(organizations)`, passing the table to a helper, `organizations['x']`, a
 * destructure — is reported. So are the relational API (`query.organizations`, a computed `query[…]` key, a
 * `with: { organization … }` relation) and raw SQL text (a `sql` tag, `sql.raw`, a string handed to `db.execute`) that
 * reads FROM / JOINs the organizations table with `policies`, a `*` (`select *`, `o.*`, `returning *`) or a whole-row
 * function (`row_to_json(o)`, `to_jsonb(o)`, `json_agg(o)`, …). An identifier spliced in (`sql.identifier('policies')`,
 * `sql.raw('…')`) counts as its text, and a table obtained from a dynamic `import()` / `require()` of a schema module
 * (destructured, or read off it) is the table.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './walk';

export interface PolicyColumnRead {
  file: string;
  line: number;
  what: string;
}

const TABLE = 'organizations';
const COLUMN = 'policies';
const SCHEMA_MODULE = /^@pagespace\/db(?:\/schema(?:\/organizations)?)?$|(?:^|\/)schema(?:\/organizations)?$|(?:^|\/)organizations$/;
/** Raw SQL that reads the table: FROM / JOIN / UPDATE / INTO organizations (quoted or not). */
const SQL_READS_TABLE = /\b(?:from|join|update|into)\s+"?organizations"?(?![\w$])/i;
const SQL_NAMES_COLUMN = /(?:^|[^\w$])"?policies"?(?![\w$])/i;
/** `select *`, `o.*`, `returning *`: every column, the policies one included. */
const SQL_STAR = /(?:\bselect\s+(?:distinct\s+)?\*|[\w"]\.\*|\breturning\s+\*)/i;
/** Functions that turn a whole row into a value: every column, the policies one included. */
const SQL_WHOLE_ROW = /\b(?:row_to_json|to_jsonb?|jsonb?_agg|jsonb?_build_array|array_agg|hstore|jsonb?_populate_record)\s*\(/i;
/** A module specifier or file path (`@pagespace/lib/organizations/policies`) is not SQL. */
const PATH_LIKE = /^[\w@.~/-]+$/;
const SOURCE_CALLS = new Set(['from', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin', 'crossJoin']);
const WRITE_CALLS = new Set(['insert', 'update', 'delete']);
const SELECT_CALLS = /^select(?:Distinct(?:On)?)?$/;
/** Relation names that resolve to the organizations table (schema/organizations.ts, core.ts). */
const ORG_RELATIONS = new Set(['organization', 'organizations', 'org']);

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

/** Is this identifier occurrence a NAME being declared or a property key, rather than a value use? */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) ||
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isVariableDeclaration(p) && p.name === id) ||
    (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) ||
    (ts.isParameter(p) && p.name === id) ||
    ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)) && p.name === id) ||
    ts.isQualifiedName(p) || ts.isTypeReferenceNode(p)
  );
}

const inTypePosition = (node: ts.Node): boolean => {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isTypeNode(cur) || ts.isTypeAliasDeclaration(cur) || ts.isInterfaceDeclaration(cur)) return true;
    if (ts.isStatement(cur) || ts.isSourceFile(cur)) return false;
  }
  return false;
};

interface Bindings {
  /** Local names bound to the table object. */
  aliases: Set<string>;
  /** Namespace imports of a schema module: `ns.organizations` is the table. */
  namespaces: Set<string>;
}

function bindingsOf(sf: ts.SourceFile): Bindings {
  const aliases = new Set<string>();
  const namespaces = new Set<string>();
  const localNames = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const fromSchema = SCHEMA_MODULE.test(stmt.moduleSpecifier.text);
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (fromSchema) namespaces.add(bindings.name.text);
      continue;
    }
    for (const el of bindings.elements) {
      if (fromSchema && (el.propertyName ?? el.name).text === TABLE) aliases.add(el.name.text);
    }
  }
  // `const { organizations } = await import('…schema…')` / `= require('…schema…')`, and `const s = await import(…)`.
  const visitDynamic = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && schemaModuleLoad(node.initializer)) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name;
          if (ts.isIdentifier(key) && key.text === TABLE && ts.isIdentifier(el.name)) aliases.add(el.name.text);
        }
      } else if (ts.isIdentifier(node.name)) {
        namespaces.add(node.name.text);
      }
    }
    ts.forEachChild(node, visitDynamic);
  };
  visitDynamic(sf);
  // A local of the bare name that is not the table (a component's `organizations` prop) is not the table; a free
  // `organizations` that nothing declares fails closed as the table.
  const collect = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) localNames.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  if (!localNames.has(TABLE)) aliases.add(TABLE);
  return { aliases, namespaces };
}

/** `import('…schema…')` or `require('…schema…')`, awaited or not, in parentheses or not. */
function schemaModuleLoad(node: ts.Node): boolean {
  let cur: ts.Node = node;
  while (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression;
  if (!ts.isCallExpression(cur) || cur.arguments.length < 1) return false;
  const isLoader = cur.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(cur.expression) && cur.expression.text === 'require');
  const spec = cur.arguments[0];
  // A computed specifier could name any module: it fails closed as a schema load.
  return isLoader && (!ts.isStringLiteralLike(spec) || SCHEMA_MODULE.test(spec.text));
}

function isTableRef(node: ts.Node, b: Bindings): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isTableRef(node.expression, b);
  if (ts.isIdentifier(node)) return b.aliases.has(node.text);
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== TABLE) return false;
  return (ts.isIdentifier(node.expression) && b.namespaces.has(node.expression.text)) || schemaModuleLoad(node.expression);
}

/** The `select(...)` call at the root of a query-builder chain, walking receivers down from `node`. */
function chainSelect(node: ts.Expression): ts.CallExpression | null {
  let cur: ts.Expression = node;
  while (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur)) {
    if (ts.isCallExpression(cur) && SELECT_CALLS.test(calleeName(cur) ?? '')) return cur;
    cur = cur.expression;
  }
  return null;
}

/**
 * The object literal a projection names: written in place, or a `const` of this file initialised with one
 * (`const ORG_RECORD = { id: organizations.id, … }`, possibly `as const`). Anything else is not provably named.
 */
function projectionLiteral(arg: ts.Expression): ts.ObjectLiteralExpression | null {
  let expr: ts.Expression = arg;
  while (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (!ts.isIdentifier(expr)) return null;
  const sf = expr.getSourceFile();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === expr.text && decl.initializer) return projectionLiteral(decl.initializer);
    }
  }
  return null;
}

/** True when a projection names every output as a column expression: no spread, no shorthand, no table value. */
function namesColumns(arg: ts.Expression | undefined, b: Bindings): boolean {
  const literal = arg ? projectionLiteral(arg) : null;
  return literal !== null && literal.properties.every((p) => ts.isPropertyAssignment(p) && !isTableRef(p.initializer, b));
}

const selectNamesColumns = (select: ts.CallExpression, b: Bindings): boolean => select.arguments.length === 1 && namesColumns(select.arguments[0], b);

/** Every `.returning(...)` call in the chain above a write. */
function returningCalls(write: ts.CallExpression): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  let cur: ts.Node = write;
  while (cur.parent && (ts.isPropertyAccessExpression(cur.parent) || (ts.isCallExpression(cur.parent) && cur.parent.expression === cur))) {
    cur = cur.parent;
    if (ts.isCallExpression(cur) && calleeName(cur) === 'returning') out.push(cur);
  }
  return out;
}

/** Why this use of the table is not a named-column use, or null when it is one. */
function classifyTableUse(ref: ts.Expression, b: Bindings): string | null {
  const p = ref.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === ref) {
    const col = p.name.text;
    if (col === COLUMN) return `${TABLE}.${COLUMN}`;
    if (col.startsWith('$') || col.startsWith('_')) return `${TABLE}.${col}`;
    return null;
  }
  if (ts.isVariableDeclaration(p) && p.initializer === ref && ts.isIdentifier(p.name)) return null; // an alias, tracked
  if (ts.isCallExpression(p) && p.arguments[0] === ref) {
    const name = calleeName(p);
    if (name && SOURCE_CALLS.has(name)) {
      const select = ts.isPropertyAccessExpression(p.expression) ? chainSelect(p.expression.expression) : null;
      return select && selectNamesColumns(select, b) ? null : `whole row: ${name}(${TABLE}) under an unnamed select`;
    }
    if (name && WRITE_CALLS.has(name)) {
      const bare = returningCalls(p).some((r) => !namesColumns(r.arguments[0], b));
      return bare ? `whole row: ${name}(${TABLE}).returning()` : null;
    }
    if (name === 'relations') return null;
  }
  return `unclassified use of the ${TABLE} table`;
}

/** The text a spliced identifier or raw fragment puts into SQL: `sql.identifier('policies')`, `sql.raw('…')`. */
function splicedText(expr: ts.Expression): string | null {
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return null;
  if (!['identifier', 'raw'].includes(expr.expression.name.text)) return null;
  const parts = expr.arguments.filter(ts.isStringLiteralLike).map((a) => a.text);
  return parts.length > 0 ? parts.join('.') : null;
}

/** The SQL text a string or template literal spells, with a table-alias substitution rendered as the table name. */
function literalText(node: ts.Node, b: Bindings): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  let text = node.head.text;
  for (const span of node.templateSpans) {
    text += isTableRef(span.expression, b) ? ` ${TABLE} ` : ` ${splicedText(span.expression) ?? '?'} `;
    text += span.literal.text;
  }
  return text;
}

/** Every read of the policies column, or of the organizations table in a shape that does not name its columns. */
export function scanSourceForPolicyColumnReads(file: string, source: string): PolicyColumnRead[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const b = bindingsOf(sf);
  // Re-bound aliases (`const t = organizations`), to a fixpoint.
  for (let grew = true; grew;) {
    grew = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isTableRef(node.initializer, b) && !b.aliases.has(node.name.text)) {
        b.aliases.add(node.name.text);
        grew = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const out: PolicyColumnRead[] = [];
  const report = (node: ts.Node, what: string): void => {
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (isTableRef(node, b) && !(ts.isIdentifier(node) && (isDeclarationName(node) || inTypePosition(node)))) {
      const why = classifyTableUse(node as ts.Expression, b);
      if (why) report(node, why);
      if (ts.isPropertyAccessExpression(node)) return;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === TABLE && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') {
      report(node, `query.${TABLE}`);
    } else if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') {
      report(node, 'query[…]');
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'with' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const rel of node.initializer.properties) {
        const key = rel.name && (ts.isIdentifier(rel.name) || ts.isStringLiteral(rel.name)) ? rel.name.text : null;
        if (key && ORG_RELATIONS.has(key)) report(rel, `with: { ${key} } relation`);
      }
    } else {
      const text = literalText(node, b);
      if (text !== null && !PATH_LIKE.test(text) && SQL_READS_TABLE.test(text) && (SQL_NAMES_COLUMN.test(text) || SQL_STAR.test(text) || SQL_WHOLE_ROW.test(text))) report(node, 'raw sql text');
      if (ts.isTemplateExpression(node)) {
        // The spans' literal text is already judged as part of the whole; their expressions are code to visit.
        for (const span of node.templateSpans) if (!isTableRef(span.expression, b)) visit(span.expression);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Scan repo-relative files. */
export function scanPolicyColumnReads(files: readonly string[]): PolicyColumnRead[] {
  return files.flatMap((file) => scanSourceForPolicyColumnReads(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')));
}
