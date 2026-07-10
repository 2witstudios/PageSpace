/**
 * Codemod (issue #1393): rewrite every `@/lib/auth` barrel import to a direct
 * per-module import, and split every `vi.mock('@/lib/auth', factory)` into one
 * `vi.mock` per target module.
 *
 * Uses ts-morph (real AST) because the test mocks require splitting a single
 * factory object across the modules its symbols now live in — regex can't do
 * that safely. See the symbol → module map below (mirrors the plan).
 *
 * Usage:
 *   bun scripts/migrate-auth-barrel.mjs --app web   --dir apps/web/src   [--dry] [--files a,b]
 *   bun scripts/migrate-auth-barrel.mjs --app admin --dir apps/admin/src [--dry] [--files a,b]
 *
 * Any barrel symbol not in the map ⇒ [WARN] + non-zero exit (fix the map).
 */
import { Project, SyntaxKind, Node, QuoteKind } from 'ts-morph';
import { resolve, dirname, relative } from 'path';
import { readdirSync, statSync } from 'fs';

// ─── Symbol → target-module maps ────────────────────────────────────────────────

const WEB_MAP = {
  // auth-types
  TokenType: '@/lib/auth/auth-types',
  MCPAuthResult: '@/lib/auth/auth-types',
  SessionAuthResult: '@/lib/auth/auth-types',
  OAuthAuthResult: '@/lib/auth/auth-types',
  AuthResult: '@/lib/auth/auth-types',
  AuthError: '@/lib/auth/auth-types',
  AuthenticationResult: '@/lib/auth/auth-types',
  AllowedTokenType: '@/lib/auth/auth-types',
  AuthenticateOptions: '@/lib/auth/auth-types',
  EnforcedAuthSuccess: '@/lib/auth/auth-types',
  EnforcedAuthError: '@/lib/auth/auth-types',
  EnforcedAuthResult: '@/lib/auth/auth-types',
  // auth-core (pure)
  getBearerToken: '@/lib/auth/auth-core',
  isAuthError: '@/lib/auth/auth-core',
  isMCPAuthResult: '@/lib/auth/auth-core',
  isSessionAuthResult: '@/lib/auth/auth-core',
  isOAuthAuthResult: '@/lib/auth/auth-core',
  isEnforcedAuthError: '@/lib/auth/auth-core',
  isManageKeysOnly: '@/lib/auth/auth-core',
  getAllowedDriveIds: '@/lib/auth/auth-core',
  checkMCPDriveScope: '@/lib/auth/auth-core',
  filterDrivesByMCPScope: '@/lib/auth/auth-core',
  checkMCPCreateScope: '@/lib/auth/auth-core',
  // request-auth (I/O shell)
  validateMCPToken: '@/lib/auth/request-auth',
  validateOAuthAccessToken: '@/lib/auth/request-auth',
  validateSessionToken: '@/lib/auth/request-auth',
  authenticateMCPRequest: '@/lib/auth/request-auth',
  authenticateOAuthRequest: '@/lib/auth/request-auth',
  authenticateSessionRequest: '@/lib/auth/request-auth',
  authenticateHybridRequest: '@/lib/auth/request-auth',
  authenticateRequestWithOptions: '@/lib/auth/request-auth',
  authenticateWithEnforcedContext: '@/lib/auth/request-auth',
  checkMCPPageScope: '@/lib/auth/request-auth',
  // token-prefixes
  MCP_TOKEN_PREFIX: '@/lib/auth/token-prefixes',
  SESSION_TOKEN_PREFIX: '@/lib/auth/token-prefixes',
  OAUTH_ACCESS_TOKEN_PREFIX: '@/lib/auth/token-prefixes',
  // principal-permissions
  isScopedMCPAuth: '@/lib/auth/principal-permissions',
  isScopedOAuthAuth: '@/lib/auth/principal-permissions',
  getPrincipalAccessLevel: '@/lib/auth/principal-permissions',
  canPrincipalViewPage: '@/lib/auth/principal-permissions',
  canPrincipalEditPage: '@/lib/auth/principal-permissions',
  canPrincipalDeletePage: '@/lib/auth/principal-permissions',
  canPrincipalSharePage: '@/lib/auth/principal-permissions',
  isPrincipalDriveMember: '@/lib/auth/principal-permissions',
  getPrincipalDriveAccess: '@/lib/auth/principal-permissions',
  isPrincipalDriveOwnerOrAdmin: '@/lib/auth/principal-permissions',
  getPrincipalDriveIds: '@/lib/auth/principal-permissions',
  getPrincipalAccessiblePagesInDrive: '@/lib/auth/principal-permissions',
  getPrincipalBatchPagePermissions: '@/lib/auth/principal-permissions',
  // auth (route guards)
  verifyAuth: '@/lib/auth/auth',
  verifyAdminAuth: '@/lib/auth/auth',
  isAdminAuthError: '@/lib/auth/auth',
  withAdminAuth: '@/lib/auth/auth',
  VerifiedUser: '@/lib/auth/auth',
  AdminRouteContext: '@/lib/auth/auth',
  // csrf / origin
  validateCSRF: '@/lib/auth/csrf-validation',
  validateOrigin: '@/lib/auth/origin-validation',
  requiresOriginValidation: '@/lib/auth/origin-validation',
  validateOriginForMiddleware: '@/lib/auth/origin-validation',
  isOriginValidationBlocking: '@/lib/auth/origin-validation',
  OriginValidationMode: '@/lib/auth/origin-validation',
  MiddlewareOriginValidationResult: '@/lib/auth/origin-validation',
  // collapsed double-hops
  getClientIP: '@pagespace/lib/security/client-ip',
  isSafeReturnUrl: '@/lib/auth/url-utils',
  // device / login-csrf / cookies
  revokeSessionsForLogin: '@/lib/auth/device-auth-helpers',
  createDeviceToken: '@/lib/auth/device-auth-helpers',
  createWebDeviceToken: '@/lib/auth/device-auth-helpers',
  validateLoginCSRFToken: '@/lib/auth/login-csrf-utils',
  COOKIE_CONFIG: '@/lib/auth/cookie-config',
  createSessionCookie: '@/lib/auth/cookie-config',
  createClearSessionCookie: '@/lib/auth/cookie-config',
  createLoggedInIndicatorCookie: '@/lib/auth/cookie-config',
  createClearLoggedInIndicatorCookie: '@/lib/auth/cookie-config',
  appendSessionCookie: '@/lib/auth/cookie-config',
  appendClearCookies: '@/lib/auth/cookie-config',
  getSessionFromCookies: '@/lib/auth/cookie-config',
};

const ADMIN_MAP = {
  withAdminAuth: '@/lib/auth/auth',
  verifyAdminAuth: '@/lib/auth/auth',
  isAdminAuthError: '@/lib/auth/auth',
  VerifiedAdminUser: '@/lib/auth/auth',
  AdminRouteContext: '@/lib/auth/auth',
  validateCSRF: '@/lib/auth/csrf-validation',
  validateAdminAccess: '@/lib/auth/admin-role',
  updateUserRole: '@/lib/auth/admin-role',
  AdminValidationResult: '@/lib/auth/admin-role',
  appendSessionCookie: '@/lib/auth/cookie-config',
  getSessionFromCookies: '@/lib/auth/cookie-config',
  createSessionCookie: '@/lib/auth/cookie-config',
  createClearSessionCookie: '@/lib/auth/cookie-config',
  COOKIE_CONFIG: '@/lib/auth/cookie-config',
};

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
}
const APP = flag('app') || 'web';
const DIR = flag('dir') || (APP === 'admin' ? 'apps/admin/src' : 'apps/web/src');
const DRY = Boolean(flag('dry'));
const ONLY = flag('files') ? String(flag('files')).split(',').map((s) => s.trim()) : null;

const MAP = APP === 'admin' ? ADMIN_MAP : WEB_MAP;
const ROOT = resolve(process.cwd());
const DIR_ABS = resolve(ROOT, DIR);
const BARREL_ALIAS = '@/lib/auth';
const BARREL_DIR_ABS = resolve(DIR_ABS, 'lib/auth'); // the auth dir; `.../lib/auth` and `.../lib/auth/index` both resolve here

// ─── File discovery ─────────────────────────────────────────────────────────────

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'dist', '.turbo'].includes(entry.name)) continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Is `spec` (as imported from `fromFileAbs`) the auth barrel? */
function isBarrelSpec(spec, fromFileAbs) {
  if (spec === BARREL_ALIAS || spec === `${BARREL_ALIAS}/index`) return true;
  if (spec.startsWith('.')) {
    // `.../lib/auth` (directory → index) and `.../lib/auth/index` both count.
    const resolved = resolve(dirname(fromFileAbs), spec)
      .replace(/\.(ts|tsx)$/, '')
      .replace(/\/index$/, '');
    return resolved === BARREL_DIR_ABS;
  }
  return false;
}

// ─── Symbol grouping helpers ─────────────────────────────────────────────────────

const warnings = [];
function targetFor(name, ctx) {
  const t = MAP[name];
  if (!t) warnings.push(`${ctx}: unmapped symbol '${name}'`);
  return t;
}

// ─── Import declaration rewriting ────────────────────────────────────────────────

function rewriteImports(sf) {
  let changed = false;
  const fileAbs = sf.getFilePath();
  const ctx = relative(ROOT, fileAbs);

  // Collect every barrel-imported symbol across all barrel decls, then remove them.
  // module -> Map(key -> { name, alias, isType })   key dedupes name+alias.
  const additions = new Map();
  let insertAt = Infinity;

  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!isBarrelSpec(spec, fileAbs)) continue;

    if (imp.getDefaultImport() || imp.getNamespaceImport()) {
      warnings.push(`${ctx}: default/namespace import from barrel not supported`);
      continue;
    }

    const declTypeOnly = imp.isTypeOnly();
    for (const ni of imp.getNamedImports()) {
      const name = ni.getName();
      const aliasNode = ni.getAliasNode();
      const alias = aliasNode ? aliasNode.getText() : undefined;
      const isType = declTypeOnly || ni.isTypeOnly();
      const target = targetFor(name, ctx);
      if (!target) continue;
      if (!additions.has(target)) additions.set(target, new Map());
      additions.get(target).set(`${name}|${alias ?? ''}`, { name, alias, isType });
    }
    imp.remove();
    changed = true;
  }

  if (!changed) return false;

  for (const [moduleSpec, specs] of additions) {
    addNamedImports(sf, moduleSpec, [...specs.values()]);
  }
  return true;
}

/** Merge named imports into an existing decl for `moduleSpec`, or create one. */
function addNamedImports(sf, moduleSpec, specs) {
  // Prefer an existing NON-type-only import decl for this module so we can hold
  // both value and (inline `type`) specifiers on one line.
  const existing = sf
    .getImportDeclarations()
    .filter((d) => d.getModuleSpecifierValue() === moduleSpec && !d.getNamespaceImport() && !d.getDefaultImport());
  const valueDecl = existing.find((d) => !d.isTypeOnly());
  const allValueTypes = specs.every((s) => s.isType);

  let decl = valueDecl;
  if (!decl && existing.length && allValueTypes) decl = existing[0]; // an `import type` decl is fine if all-type

  if (decl) {
    const declTypeOnly = decl.isTypeOnly();
    const present = new Set(decl.getNamedImports().map((n) => `${n.getName()}|${n.getAliasNode()?.getText() ?? ''}`));
    const toAdd = specs
      .filter((s) => !present.has(`${s.name}|${s.alias ?? ''}`))
      .map((s) => ({ name: s.name, alias: s.alias, isTypeOnly: declTypeOnly ? false : s.isType }));
    if (toAdd.length) decl.addNamedImports(toAdd);
    return;
  }

  // Fresh declaration — build with the full named list in one call (ts-morph
  // mis-handles the empty-then-add path).
  sf.addImportDeclaration({
    moduleSpecifier: moduleSpec,
    isTypeOnly: allValueTypes,
    namedImports: specs.map((s) => ({
      name: s.name,
      alias: s.alias,
      isTypeOnly: allValueTypes ? false : s.isType,
    })),
  });
}

// ─── vi.mock factory splitting ───────────────────────────────────────────────────

function getReturnedObjectLiteral(factory) {
  if (!factory) return null;
  if (Node.isArrowFunction(factory) || Node.isFunctionExpression(factory)) {
    const body = factory.getBody();
    if (Node.isParenthesizedExpression(body)) {
      const inner = body.getExpression();
      if (Node.isObjectLiteralExpression(inner)) return inner;
    }
    if (Node.isObjectLiteralExpression(body)) return body;
    if (Node.isBlock(body)) {
      const ret = body
        .getStatements()
        .reverse()
        .find((s) => Node.isReturnStatement(s));
      if (ret) {
        let expr = ret.getExpression();
        if (expr && Node.isParenthesizedExpression(expr)) expr = expr.getExpression();
        if (expr && Node.isObjectLiteralExpression(expr)) return expr;
      }
    }
  }
  return null;
}

function rewriteViMocks(sf) {
  let changed = false;
  const fileAbs = sf.getFilePath();
  const ctx = relative(ROOT, fileAbs);

  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const e = call.getExpression();
    if (!Node.isPropertyAccessExpression(e)) return false;
    if (e.getExpression().getText() !== 'vi') return false;
    const m = e.getName();
    if (m !== 'mock' && m !== 'doMock') return false;
    const arg0 = call.getArguments()[0];
    return arg0 && Node.isStringLiteral(arg0) && isBarrelSpec(arg0.getLiteralValue(), fileAbs);
  });

  for (const call of calls) {
    const args = call.getArguments();
    const factory = args[1];

    // No factory: `vi.mock('@/lib/auth')` (auto-mock). Ambiguous across modules;
    // this pattern is not used for the barrel — warn if seen.
    if (!factory) {
      warnings.push(`${ctx}: vi.mock without factory on barrel — cannot split`);
      continue;
    }

    const obj = getReturnedObjectLiteral(factory);
    if (!obj) {
      warnings.push(`${ctx}: vi.mock factory shape not recognized — handle manually`);
      continue;
    }

    const usesImportOriginal = factory.getText().includes('importOriginal');
    let spreadPresent = false;
    const byModule = new Map(); // module -> [propText]

    let ok = true;
    for (const prop of obj.getProperties()) {
      if (Node.isSpreadAssignment(prop)) {
        spreadPresent = true;
        continue;
      }
      let name;
      if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop) ||
          Node.isMethodDeclaration(prop) || Node.isGetAccessorDeclaration(prop)) {
        name = prop.getName();
      } else {
        warnings.push(`${ctx}: unsupported mock property '${prop.getKindName()}'`);
        ok = false;
        continue;
      }
      const target = targetFor(name, ctx);
      if (!target) { ok = false; continue; }
      if (!byModule.has(target)) byModule.set(target, []);
      byModule.get(target).push(prop.getText().trim());
    }
    if (!ok) continue;

    // Build one vi.mock per module that received override props. A module touched
    // only by the spread needs no mock (its real module is used).
    const stmt = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
    if (!stmt) { warnings.push(`${ctx}: vi.mock not a statement`); continue; }

    const method = call.getExpression().getKind && Node.isPropertyAccessExpression(call.getExpression())
      ? call.getExpression().getName()
      : 'mock';

    const blocks = [];
    for (const [moduleSpec, props] of byModule) {
      const spread = spreadPresent || usesImportOriginal;
      if (spread) {
        blocks.push(
          `vi.${method}('${moduleSpec}', async (importOriginal) => ({\n` +
            `  ...(await importOriginal()),\n` +
            props.map((p) => `  ${p},`).join('\n') +
            `\n}));`
        );
      } else {
        blocks.push(
          `vi.${method}('${moduleSpec}', () => ({\n` +
            props.map((p) => `  ${p},`).join('\n') +
            `\n}));`
        );
      }
    }

    if (blocks.length === 0) {
      // Pure passthrough (spread only, no overrides) — mocking a module as itself
      // is a no-op; drop it.
      stmt.remove();
    } else {
      stmt.replaceWithText(blocks.join('\n'));
    }
    changed = true;
  }
  return changed;
}

// ─── Main ────────────────────────────────────────────────────────────────────────

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: { allowJs: false },
  manipulationSettings: { useTrailingCommas: true, quoteKind: QuoteKind.Single },
});

let candidates = walk(DIR_ABS);
if (ONLY) {
  const set = new Set(ONLY.map((f) => resolve(ROOT, f)));
  candidates = candidates.filter((f) => set.has(f));
}

let touched = 0;
for (const file of candidates) {
  const sf = project.addSourceFileAtPath(file);
  const text = sf.getFullText();
  if (!text.includes('lib/auth')) {
    project.removeSourceFile(sf);
    continue;
  }
  const a = rewriteImports(sf);
  const b = rewriteViMocks(sf);
  if (a || b) {
    touched++;
    if (DRY) {
      console.log(`~ ${relative(ROOT, file)}`);
      project.removeSourceFile(sf); // discard
    } else {
      sf.saveSync();
    }
  } else {
    project.removeSourceFile(sf);
  }
}

console.log(`\n${DRY ? '[dry] would touch' : 'touched'} ${touched} files`);
if (warnings.length) {
  console.error(`\n${warnings.length} WARNING(S):`);
  for (const w of [...new Set(warnings)]) console.error(`  [WARN] ${w}`);
  process.exit(1);
}
