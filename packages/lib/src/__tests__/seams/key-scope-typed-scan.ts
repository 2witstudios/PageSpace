/**
 * The TYPE-BASED half of the key-scope read seam (key-scope-reads.seam.test.ts), review #2849 r8.
 *
 * Name rules (key-scope-read-scan.ts) cannot follow a value through a rename: `const { drives } = auth.scopes`, or
 * `const grant = auth.scopes; grant.drives`, or a token row fetched with `db.query.oauthAccessTokens` and read as
 * `row.scopes`. This scanner asks the TypeScript checker what each receiver IS:
 *
 *   - a read of `drives` (by dot, string bracket or destructuring) on a value whose type is a ScopeSet: recognised by
 *     shape (`drives` + `account` + `manageKeys`), so an alias of the type, an intersection or a narrowed copy counts;
 *   - a read of `scopes` on a value typed as an OAuth token or code row: recognised by shape (`scopes` + `clientId`,
 *     the pair every one of oauth_access_tokens, oauth_refresh_tokens, oauth_authorization_codes and oauth_device_codes
 *     carries), or by any `scopes: string[]` (a hand-written record over a row; fails closed on other string scopes).
 *
 * The checker runs over the files that mention `scopes` at all (a cheap text prefilter; a ScopeSet or token row can
 * only be READ by name in such a file, or reach it through a function in one), with one Program per tsconfig.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './walk';
import { enclosingFunction, functionName } from './loosening-write-scan';
import type { ScopeRead } from './key-scope-read-scan';

const SCOPE_SET_SHAPE = ['drives', 'account', 'manageKeys'] as const;
const OAUTH_ROW_SHAPE = ['scopes', 'clientId'] as const;

/** The tsconfig that owns each scanned root. */
const PROJECTS: ReadonlyArray<{ root: string; tsconfig: string }> = [
  { root: 'apps/web/', tsconfig: 'apps/web/tsconfig.json' },
  { root: 'packages/lib/src/', tsconfig: 'packages/lib/tsconfig.json' },
];

const nameOf = (fnNode: ts.Node | null): string => (fnNode ? (functionName(fnNode) ?? '<anonymous>') : '<module>');

/** True when every constituent of `type` (a union is judged member by member) carries all of `props`. */
function hasShape(checker: ts.TypeChecker, type: ts.Type, props: readonly string[]): boolean {
  const nonNullable = checker.getNonNullableType(type);
  const parts = nonNullable.isUnion() ? nonNullable.types : [nonNullable];
  return parts.length > 0 && parts.some((part) => props.every((p) => checker.getPropertyOfType(part, p) !== undefined));
}

/**
 * True when the receiver carries a `scopes` that is an array of strings: a stored OAuth grant, whether the value is a
 * table row, a `db.query` row, or a hand-written record type over one (e.g. OAuthAccessTokenRecord, which has no
 * clientId). Fails closed: any other `scopes: string[]` (a third-party integration's) is flagged too and ledgered.
 */
function hasStringArrayScopes(checker: ts.TypeChecker, type: ts.Type): boolean {
  const nonNullable = checker.getNonNullableType(type);
  const parts = nonNullable.isUnion() ? nonNullable.types : [nonNullable];
  return parts.some((part) => {
    const prop = checker.getPropertyOfType(part, 'scopes');
    if (!prop) return false;
    const propType = checker.getNonNullableType(checker.getTypeOfSymbol(prop));
    if (!checker.isArrayType(propType)) return false;
    const [element] = checker.getTypeArguments(propType as ts.TypeReference);
    return element !== undefined && (element.flags & ts.TypeFlags.StringLike) !== 0;
  });
}

function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    return node.argumentExpression.text;
  }
  return null;
}

function scanSourceFile(checker: ts.TypeChecker, sf: ts.SourceFile, file: string): ScopeRead[] {
  const out: ScopeRead[] = [];
  const at = (node: ts.Node, what: string) =>
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fn: nameOf(enclosingFunction(node)), what });
  const judge = (node: ts.Node, member: string, receiverType: ts.Type) => {
    if (member === 'drives' && hasShape(checker, receiverType, SCOPE_SET_SHAPE)) at(node, 'ScopeSet.drives (typed)');
    else if (member === 'scopes' && (hasShape(checker, receiverType, OAUTH_ROW_SHAPE) || hasStringArrayScopes(checker, receiverType))) {
      at(node, 'oauth row.scopes (typed)');
    }
  };
  const visit = (node: ts.Node): void => {
    const member = memberName(node);
    if ((member === 'drives' || member === 'scopes') && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      judge(node, member, checker.getTypeAtLocation(node.expression));
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
      if (keyText === 'drives' || keyText === 'scopes') judge(node, keyText, checker.getTypeAtLocation(node.parent));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The type-based reads in `files` (repo-relative), plus how long the checker took. */
export function scanTypedScopeReads(files: readonly string[]): { reads: ScopeRead[]; ms: number } {
  const started = Date.now();
  const reads: ScopeRead[] = [];
  for (const { root, tsconfig } of PROJECTS) {
    const roots = files.filter((f) => f.startsWith(root) && /\bscopes\b/.test(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')));
    if (roots.length === 0) continue;
    const configPath = path.join(REPO_ROOT, tsconfig);
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    const program = ts.createProgram({ rootNames: roots.map((f) => path.join(REPO_ROOT, f)), options: { ...parsed.options, noEmit: true } });
    const checker = program.getTypeChecker();
    for (const file of roots) {
      const sf = program.getSourceFile(path.join(REPO_ROOT, file));
      if (sf) reads.push(...scanSourceFile(checker, sf, file));
    }
  }
  return { reads, ms: Date.now() - started };
}

/** The type-based reads in one in-memory source (for the seam's self-test): no tsconfig, strict defaults. */
export function scanTypedSource(file: string, source: string): ScopeRead[] {
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts'], noEmit: true };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === file ? ts.createSourceFile(file, source, languageVersion, true) : original(name, languageVersion, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === file || fileExists(name);
  const program = ts.createProgram({ rootNames: [file], options, host });
  const sf = program.getSourceFile(file);
  return sf ? scanSourceFile(program.getTypeChecker(), sf, file) : [];
}
