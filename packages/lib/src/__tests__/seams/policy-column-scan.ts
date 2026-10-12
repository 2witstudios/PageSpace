/**
 * Scanner for the POL-1 policy-column seam (policy-column.seam.test.ts).
 *
 * "Policies are … read through one function; no route reads the org row directly." The stored column is
 * `organizations.policies`. This scanner parses every source file with the TypeScript compiler (not a line regex) and
 * reports each place that could read the column:
 *   - the Drizzle column: `organizations.policies`, `organizations['policies']`, `const { policies } = organizations`;
 *   - a whole row, which carries the column unnamed: `select().from(organizations)`, `getTableColumns(organizations)`,
 *     a bare `.returning()` on `insert|update(organizations)`, `query.organizations`, a computed `query[…]` key;
 *   - raw SQL: any string or template text (a `sql` tag, `sql.raw('…')`, `db.execute('…')`, a constant handed to
 *     one of them) that names both the `organizations` table and the `policies` column. A template's
 *     `${organizations}` substitution counts as naming the table.
 * The `organizations` identifier is matched by name and by every local alias it is imported under, so the scan
 * fails closed: a variable that merely shares the name is reported and must be renamed.
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
const SCHEMA_MODULE = /^@pagespace\/db(?:\/schema(?:\/organizations)?)?$|(?:^|\/)organizations$/;
const NAMES_TABLE = /(?:^|[^\w$])"?organizations"?(?![\w$])/i;
const NAMES_COLUMN = /(?:^|[^\w$])"?policies"?(?![\w$])/i;
/** A module specifier or file path (`@pagespace/lib/organizations/policies`) names both words but is not SQL. */
const PATH_LIKE = /^[\w@.~/-]+$/;

/** Every local name the `organizations` table object is bound to in this file (the bare name always counts). */
function tableAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set([TABLE]);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!SCHEMA_MODULE.test(stmt.moduleSpecifier.text)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if ((el.propertyName ?? el.name).text === TABLE) aliases.add(el.name.text);
    }
  }
  return aliases;
}

/** The SQL text a string or template literal spells, with a table-alias substitution rendered as the table name. */
function literalText(node: ts.Node, aliases: Set<string>): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  let text = node.head.text;
  for (const span of node.templateSpans) {
    text += ts.isIdentifier(span.expression) && aliases.has(span.expression.text) ? ` ${TABLE} ` : ' ? ';
    text += span.literal.text;
  }
  return text;
}

const isAlias = (node: ts.Node, aliases: Set<string>): boolean => ts.isIdentifier(node) && aliases.has(node.text);

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

/** True when a `.returning()` call's receiver chain contains `insert(organizations)` or `update(organizations)`. */
function chainWritesTable(node: ts.Node, aliases: Set<string>): boolean {
  let cur: ts.Node = node;
  while (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur)) {
    if (ts.isCallExpression(cur)) {
      const name = calleeName(cur);
      if ((name === 'insert' || name === 'update') && cur.arguments.length === 1 && isAlias(cur.arguments[0], aliases)) return true;
    }
    cur = cur.expression;
  }
  return false;
}

/** Every read of the policies column (or of a whole organizations row) in one source text. */
export function scanSourceForPolicyColumnReads(file: string, source: string): PolicyColumnRead[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const aliases = tableAliases(sf);
  const out: PolicyColumnRead[] = [];
  const report = (node: ts.Node, what: string): void => {
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === COLUMN && isAlias(node.expression, aliases)) report(node, `${TABLE}.${COLUMN}`);
      if (node.name.text === TABLE && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') report(node, `query.${TABLE}`);
    } else if (ts.isElementAccessExpression(node)) {
      // A positional index (`organizations[0]` of a list that merely shares the name) is not a column.
      if (isAlias(node.expression, aliases) && !ts.isNumericLiteral(node.argumentExpression)) report(node, `${TABLE}[…]`);
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') report(node, 'query[…]');
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isAlias(node.initializer, aliases)) {
      report(node, `destructure ${TABLE}`);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === 'getTableColumns' && node.arguments.some((a) => isAlias(a, aliases))) report(node, `getTableColumns(${TABLE})`);
      if (name === 'from' && node.arguments.length >= 1 && isAlias(node.arguments[0], aliases)) {
        const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : null;
        if (receiver && ts.isCallExpression(receiver) && /^select(?:Distinct(?:On)?)?$/.test(calleeName(receiver) ?? '') && receiver.arguments.length === 0) {
          report(node, `select().from(${TABLE})`);
        }
      }
      if (name === 'returning' && node.arguments.length === 0 && ts.isPropertyAccessExpression(node.expression) && chainWritesTable(node.expression.expression, aliases)) {
        report(node, `returning() on ${TABLE}`);
      }
    } else {
      const text = literalText(node, aliases);
      if (text !== null && !PATH_LIKE.test(text) && NAMES_TABLE.test(text) && NAMES_COLUMN.test(text)) report(node, 'raw sql text');
      if (ts.isTemplateExpression(node)) {
        // The spans' literal text is already judged as part of the whole; their expressions are code to visit.
        for (const span of node.templateSpans) visit(span.expression);
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
