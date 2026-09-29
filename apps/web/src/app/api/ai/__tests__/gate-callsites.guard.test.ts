/**
 * Merge guards over the AI call sites. These are source-scan invariants: they read the
 * source and fail the build if a regression slips in — a model call no credit gate
 * covers, a gate caller that forgets the concurrency cap, or an OpenRouter onFinish that
 * captures cost but not the generation id the reconcile cron needs. Cheaper and more
 * durable than hoping a reviewer notices.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';

// vitest runs with cwd = apps/web; the AI routes live under src/app/api.
const WEB_DIR = process.cwd();
const SRC_DIR = join(WEB_DIR, 'src');
const API_DIR = join(SRC_DIR, 'app/api');

// Next route handlers are route.ts OR route.tsx.
const isRouteFile = (name: string) => name === 'route.ts' || name === 'route.tsx';
/** Path relative to API_DIR, normalized to forward slashes (separator-agnostic). */
const apiRelPath = (file: string) => `/api/${relative(API_DIR, file).split(sep).join('/')}`;

function allRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allRouteFiles(full));
    else if (isRouteFile(entry.name)) out.push(full);
  }
  return out;
}

const ROUTE_FILES = allRouteFiles(API_DIR);

/** The body of each `canConsumeAI(` call (from the call to its terminating `;`). */
function gateCallSlices(src: string): string[] {
  const slices: string[] = [];
  let idx = src.indexOf('canConsumeAI(');
  while (idx !== -1) {
    const end = src.indexOf(';', idx);
    slices.push(src.slice(idx, end === -1 ? undefined : end));
    idx = src.indexOf('canConsumeAI(', idx + 1);
  }
  return slices;
}

// A CALL (not the definition) of anything that builds a model client or runs one.
// `createAIProvider` is the only way a route gets a model; the AI SDK entry points
// cover helpers that run a model handed to them.
const MODEL_CALL = /(?<!function\s)\b(?:createAIProvider|streamText|generateText|generateObject|streamObject|embedMany|embed)\s*\(/;

/**
 * What counts as passing the gate: `canConsumeAI` itself, or a wrapper that takes the
 * hold through it. Each wrapper is pinned to its module below, and a test proves every
 * one of those modules really calls `canConsumeAI` or another pinned wrapper — so naming
 * a function here cannot make an ungated call look gated.
 */
const GATE_WRAPPERS: Record<string, string> = {
  acquireUserCreditHold: 'src/lib/ai/core/user-credit-hold.ts',
  gateUserCall: 'src/lib/ai/core/user-credit-hold.ts',
  acquireWorkflowCreditHold: 'src/lib/workflows/workflow-credit-gate.ts',
  creditAdmission: 'src/lib/workflows/workflow-credit-gate.ts',
  acquireMentionCreditHold: 'src/lib/channels/mention-credit-gate.ts',
  // Each memory model call reserves the person's own credits first, through gateUserCall.
  reserveMemoryCall: 'src/lib/memory/memory-credit.ts',
};
const GATE_CALL = new RegExp(`(?<!function\\s)\\b(?:${['canConsumeAI', ...Object.keys(GATE_WRAPPERS)].join('|')})\\s*\\(`);

/** Resolve an `@/lib/...` or relative import to its source file, or undefined. */
function resolveImport(specifier: string, fromFile: string): string | undefined {
  const base = specifier.startsWith('@/')
    ? join(process.cwd(), 'src', specifier.slice(2))
    : join(dirname(fromFile), specifier);
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) => existsSync(candidate));
}

/**
 * Source with comments removed, so a comment that merely MENTIONS the gate
 * (`// TODO: call canConsumeAI( here`) cannot count as a gate call, and a
 * commented-out model call cannot count as one either. Crude on purpose: a
 * `//` inside a string literal loses the rest of that line, which can only make
 * the guard stricter, never blind.
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The route plus every module it imports directly — `@/lib/...` and relative.
 * One level deep is where a route's model call hides when it is not in the route
 * itself (the /btw route streamed through `@/lib/ai/btw/side-question`), and
 * where the gate lives when a route delegates its whole turn (the chat route →
 * the chat pipeline). Deeper chains are not followed; that is a documented limit.
 */
function routeAndDirectImports(file: string): Array<{ path: string; src: string }> {
  const src = stripComments(readFileSync(file, 'utf8'));
  const imported = [...src.matchAll(/from\s+['"]((?:@\/lib\/|\.{1,2}\/)[^'"]+)['"]/g)]
    .map((match) => resolveImport(match[1], file))
    .filter((path): path is string => path !== undefined);
  return [{ path: file, src }, ...[...new Set(imported)].map((path) => ({ path, src: stripComments(readFileSync(path, 'utf8')) }))];
}

/**
 * Production files (paths relative to apps/web) that make a model call no credit gate
 * covers, BY DESIGN. Pinned exactly below: adding a file here is a billing decision,
 * not a way to quiet the guard, and each entry must say which gate its spend is under.
 *
 * The memory cron was listed here until its services took a hold of their own — a
 * user in debt kept accruing debt every night (the fourth of this class after #2700
 * and #2728). Every other model call site now passes a gate, or is reachable only
 * through files that do.
 */
const UNGATED_BY_DESIGN: Record<string, string> = {
  'src/lib/ai/tools/agent-communication-tools.ts':
    "ask_agent's nested sub-agent call. It runs only as a tool's execute inside a parent model call that already passed its gate — the chat turns, v1 completions, page-agent consult, workflow runs (creditAdmission), channel-mention replies (acquireMentionCreditHold) and voice calls (gated at the realtime handshake). It settles on its parent's walletId via AIMonitoring.trackUsage. ai-tools imports it only to assemble the tool registry, which runs nothing. The module scan below pins the same file to its gated caller (GATED_BY_CALLER).",
};

function ungatedModelRoutes(): string[] {
  const offenders: string[] = [];
  for (const file of ROUTE_FILES) {
    const scanned = routeAndDirectImports(file);
    const invokesModel = scanned.some(({ src }) => MODEL_CALL.test(src));
    const gated = scanned.some(({ src }) => GATE_CALL.test(src));
    if (invokesModel && !gated) offenders.push(webRelPath(file));
  }
  return offenders;
}

/** Path relative to apps/web, forward slashes — the key form of UNGATED_BY_DESIGN. */
const webRelPath = (file: string) => relative(WEB_DIR, file).split(sep).join('/');

const isProductionSource = (name: string) =>
  /\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !/\.(test|spec)\.tsx?$/.test(name);

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || full === join(SRC_DIR, 'test')) continue;
      out.push(...productionFiles(full));
    } else if (isProductionSource(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Value imports of one file: `from '…'`, `import '…'` and dynamic `import('…')`,
 * restricted to `@/…` and relative specifiers. `import type` / `export type` lines
 * are dropped first — a type-only import runs nothing, so it is not a caller.
 */
function valueImportSpecifiers(src: string): string[] {
  const withoutTypeImports = src.replace(/\b(?:import|export)\s+type\s[^;]*?from\s*['"][^'"]+['"]/g, '');
  return [...withoutTypeImports.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]((?:@\/|\.{1,2}\/)[^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * The credit-gate coverage rule, pure over a map of (absolute path → comment-stripped
 * source) so it can be tested on fixtures. A file that makes a model call is COVERED if
 *   - it calls a gate itself (GATE_CALL), or
 *   - it is allowlisted (UNGATED_BY_DESIGN), or
 *   - it has at least one value importer and EVERY value importer is covered.
 * So a model call is fine only if every way into it passes a gate. A file nobody imports
 * (a route, a new entry point) must gate itself. An import cycle counts as uncovered.
 * The granularity is the FILE: a gated file adding a second, ungated call passes — a
 * documented limit, the same one the route scan above has always had.
 */
function uncoveredModelCallSites(
  sources: Map<string, string>,
  srcRoot: string,
  allowlisted: (file: string) => boolean,
): string[] {
  const resolve = (specifier: string, fromFile: string): string | undefined => {
    const base = specifier.startsWith('@/') ? join(srcRoot, specifier.slice(2)) : join(dirname(fromFile), specifier);
    return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find((c) => sources.has(c));
  };

  const importers = new Map<string, Set<string>>();
  for (const [file, src] of sources) {
    for (const specifier of valueImportSpecifiers(src)) {
      const target = resolve(specifier, file);
      if (!target || target === file) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target)!.add(file);
    }
  }

  const covered = (file: string, visiting: Set<string>): boolean => {
    if (GATE_CALL.test(sources.get(file) ?? '') || allowlisted(file)) return true;
    if (visiting.has(file)) return false;
    const callers = [...(importers.get(file) ?? [])];
    if (callers.length === 0) return false;
    visiting.add(file);
    const result = callers.every((caller) => covered(caller, visiting));
    visiting.delete(file);
    return result;
  };

  return [...sources.entries()]
    .filter(([, src]) => MODEL_CALL.test(src))
    .map(([file]) => file)
    .filter((file) => !covered(file, new Set()));
}

/** The AI SDK / provider entry points MODEL_CALL matches, as callee names for the AST scan. */
const MODEL_CALLEES = new Set(['createAIProvider', 'streamText', 'generateText', 'generateObject', 'streamObject', 'embedMany', 'embed']);

/** The calls that actually run a model (building a client with createAIProvider spends nothing). */
const RUNNING_MODEL_CALLEES = new Set([...MODEL_CALLEES].filter((name) => name !== 'createAIProvider'));

/**
 * Closes the file-level blind spot for the memory services, which reserve PER CALL
 * (reserveMemoryCall) rather than through a callback wrapper. The file-level rule is
 * satisfied by one reserveMemoryCall anywhere in the file, so a second model call added
 * next to it would pass. Here, in every file that calls reserveMemoryCall, each call that
 * runs a model must sit in a function that makes EXACTLY ONE such model call, takes EXACTLY
 * ONE reserveMemoryCall lexically BEFORE it, and settles EXACTLY ONCE through a
 * trackUsage({ holdId, … }) — one hold, one settle, per model call.
 */
function memoryModelCallsWithoutOwnReservation(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const calleeName = (call: ts.CallExpression): string | undefined => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
  };
  const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
    for (let at = node.parent; at; at = at.parent) {
      if (ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at) || ts.isArrowFunction(at) || ts.isMethodDeclaration(at)) return at;
    }
    return undefined;
  };
  // The function that OWNS a call: its nearest enclosing function, skipping the inline
  // callbacks a call is commonly chained through (`.catch((e) => …)`) — those do not own it.
  const owner = (node: ts.Node): ts.Node | undefined => enclosingFunction(node);
  const settlesAHold = (call: ts.CallExpression) =>
    call.arguments.some((arg) => ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === 'holdId'));

  const byFunction = new Map<ts.Node | undefined, { models: ts.CallExpression[]; reserves: ts.CallExpression[]; settles: ts.CallExpression[] }>();
  const entry = (fn: ts.Node | undefined) => {
    if (!byFunction.has(fn)) byFunction.set(fn, { models: [], reserves: [], settles: [] });
    return byFunction.get(fn)!;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node) ?? '';
      if (RUNNING_MODEL_CALLEES.has(name)) entry(owner(node)).models.push(node);
      if (name === 'reserveMemoryCall') entry(owner(node)).reserves.push(node);
      if (name === 'trackUsage' && settlesAHold(node)) entry(owner(node)).settles.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const offenders: string[] = [];
  for (const { models, reserves, settles } of byFunction.values()) {
    for (const call of models) {
      const where = `${calleeName(call)} @ line ${line(call)}`;
      if (models.length !== 1) offenders.push(`${where}: ${models.length} model calls share one function`);
      else if (reserves.length !== 1) offenders.push(`${where}: ${reserves.length} reserveMemoryCall in its function`);
      else if (reserves[0].getStart() > call.getStart()) offenders.push(`${where}: reserved after the model call`);
      else if (settles.length !== 1) offenders.push(`${where}: ${settles.length} trackUsage({ holdId }) settles in its function`);
    }
  }
  return offenders;
}

const PRODUCTION_SOURCES = new Map(
  productionFiles(SRC_DIR).map((file) => [file, stripComments(readFileSync(file, 'utf8'))] as const),
);
const MODEL_CALL_SITES = [...PRODUCTION_SOURCES.entries()]
  .filter(([, src]) => MODEL_CALL.test(src))
  .map(([file]) => webRelPath(file));

/** Uncovered sites across apps/web, optionally ignoring the allowlist. */
const uncoveredWebSites = (honourAllowlist: boolean) =>
  uncoveredModelCallSites(PRODUCTION_SOURCES, SRC_DIR, (file) => honourAllowlist && webRelPath(file) in UNGATED_BY_DESIGN)
    .map(webRelPath);

describe('AI gate call-site guards', () => {
  it('every route that creates an AI provider or runs a model passes the credit gate', () => {
    const offenders = ungatedModelRoutes().filter((rel) => !(rel in UNGATED_BY_DESIGN));
    // A model call with no canConsumeAI = unmetered spend: no hold, no balance check,
    // no in-flight cap. Gate before the call and settle the hold via trackUsage.
    expect(offenders).toEqual([]);
  });

  it('every production model call site is gated, or reachable only through gated callers', () => {
    // The route scan above sees one import deep. This one enumerates EVERY production
    // file under src that builds or runs a model — crons, trigger executors, services —
    // and walks its importers all the way up. A call no gate covers is how a user with
    // an exhausted balance keeps spending: the debit lands after the fact as debt, and
    // only the gate refuses the next call.
    expect(uncoveredWebSites(true)).toEqual([]);
  });

  it('the ungated list is exactly these files, each with a reason', () => {
    // Pinned literally: growing the list must fail here and be argued in review.
    expect(Object.keys(UNGATED_BY_DESIGN)).toEqual(['src/lib/ai/tools/agent-communication-tools.ts']);
    for (const reason of Object.values(UNGATED_BY_DESIGN)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('every listed file is still an ungated model call site (a fixed file must leave the list)', () => {
    const uncoveredWithoutList = new Set(uncoveredWebSites(false));
    expect(Object.keys(UNGATED_BY_DESIGN).filter((rel) => !uncoveredWithoutList.has(rel))).toEqual([]);
  });

  it('every gate wrapper is defined where pinned and really calls canConsumeAI (or a wrapper pinned elsewhere)', () => {
    for (const [name, rel] of Object.entries(GATE_WRAPPERS)) {
      const src = PRODUCTION_SOURCES.get(join(WEB_DIR, rel));
      expect(src, rel).toBeDefined();
      expect(src, `${rel} defines ${name}`).toMatch(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`));
      const delegates = Object.entries(GATE_WRAPPERS).filter(([, other]) => other !== rel).map(([wrapper]) => wrapper);
      expect(src, `${rel} calls canConsumeAI`).toMatch(new RegExp(`(?<!function\\s)\\b(?:${['canConsumeAI', ...delegates].join('|')})\\s*\\(`));
    }
  });

  it('the site scan sees the known model call sites (guard is not vacuous)', () => {
    expect(MODEL_CALL_SITES).toEqual(expect.arrayContaining([
      'src/lib/memory/discovery-service.ts',
      'src/lib/memory/integration-service.ts',
      'src/lib/memory/compaction-service.ts',
      'src/lib/workflows/workflow-executor.ts',
      'src/lib/ai/chat-pipeline/page-chat-turn.ts',
      'src/lib/integrations/zoom/generate-summary.ts',
    ]));
  });

  it('no other workspace makes a model call outside this scan', () => {
    // The scan covers apps/web. A model call in another app or package would escape
    // it — bring that workspace under this guard rather than letting it pass.
    const repoRoot = join(WEB_DIR, '../..');
    const offenders: string[] = [];
    for (const workspace of ['apps', 'packages']) {
      for (const name of readdirSync(join(repoRoot, workspace))) {
        const src = join(repoRoot, workspace, name, 'src');
        if (join(repoRoot, workspace, name) === WEB_DIR || !existsSync(src)) continue;
        for (const file of productionFiles(src)) {
          if (MODEL_CALL.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(relative(repoRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('SPEND-1 (partial) inside a memory service, every model call takes exactly one reservation first and settles it exactly once', () => {
    // The file-level rule above cannot see a second call added next to an existing
    // reservation — exactly where a fourth memory pass would go.
    const offenders: Record<string, string[]> = {};
    for (const [file] of PRODUCTION_SOURCES) {
      const raw = readFileSync(file, 'utf8');
      if (!/\breserveMemoryCall\s*\(/.test(stripComments(raw)) || webRelPath(file) === GATE_WRAPPERS.reserveMemoryCall) continue;
      const outside = memoryModelCallsWithoutOwnReservation(file, raw);
      if (outside.length > 0) offenders[webRelPath(file)] = outside;
    }
    expect(offenders).toEqual({});
  });

  it('the per-call reservation scan covers the memory services (not vacuous)', () => {
    const scanned = [...PRODUCTION_SOURCES.keys()]
      .filter((file) => /\breserveMemoryCall\s*\(/.test(PRODUCTION_SOURCES.get(file) ?? ''))
      .map(webRelPath);
    expect(scanned).toEqual(expect.arrayContaining([
      'src/lib/memory/discovery-service.ts',
      'src/lib/memory/integration-service.ts',
      'src/lib/memory/compaction-service.ts',
    ]));
  });

  describe('per-call reservation rule (fixtures)', () => {
    const scan = (src: string) => memoryModelCallsWithoutOwnReservation('fixture.ts', src);

    it('passes one reservation, one model call and one settle per function', () => {
      expect(scan(`
        async function pass(u: string) {
          const provider = await createAIProvider(u, {});
          const r = await reserveMemoryCall(u, { provider: 'p', model: 'm', inputChars: 1 });
          if (!r.allowed) return [];
          const result = await generateObject({}).catch((e) => { r.release(); throw e; });
          AIMonitoring.trackUsage({ userId: u, holdId: r.holdId, walletId: r.walletId });
          return result;
        }
      `)).toEqual([]);
    });

    it('flags a second model call under the same reservation', () => {
      expect(scan(`
        export async function run(u: string) {
          const r = await reserveMemoryCall(u, {});
          await generateText({});
          await generateText({});
          AIMonitoring.trackUsage({ holdId: r.holdId });
        }
      `)).toEqual([
        'generateText @ line 4: 2 model calls share one function',
        'generateText @ line 5: 2 model calls share one function',
      ]);
    });

    it('flags a model call in a helper with no reservation of its own', () => {
      expect(scan(`
        async function pass() { return generateObject({}); }
        export async function run(u: string) { const r = await reserveMemoryCall(u, {}); await pass(); AIMonitoring.trackUsage({ holdId: r.holdId }); }
      `)).toEqual(['generateObject @ line 2: 0 reserveMemoryCall in its function']);
    });

    it('flags a reservation taken after the model call', () => {
      expect(scan(`
        export async function run(u: string) { await generateText({}); const r = await reserveMemoryCall(u, {}); AIMonitoring.trackUsage({ holdId: r.holdId }); }
      `)).toEqual(['generateText @ line 2: reserved after the model call']);
    });

    it('flags a model call whose hold is never settled (a debit without the holdId)', () => {
      expect(scan(`
        export async function run(u: string) { const r = await reserveMemoryCall(u, {}); await generateText({}); AIMonitoring.trackUsage({ userId: u }); }
      `)).toEqual(['generateText @ line 2: 0 trackUsage({ holdId }) settles in its function']);
    });
  });

  describe('coverage rule (fixtures)', () => {
    const root = '/repo/src';
    const at = (rel: string) => `${root}/${rel}`;
    const run = (files: Record<string, string>) =>
      uncoveredModelCallSites(new Map(Object.entries(files).map(([rel, src]) => [at(rel), src])), root, () => false)
        .map((file) => file.slice(root.length + 1));

    it('flags a model call nobody gates', () => {
      expect(run({ 'lib/new-feature.ts': "import { generateText } from 'ai'; export const go = () => generateText({});" }))
        .toEqual(['lib/new-feature.ts']);
    });

    it('passes a helper whose only caller gates', () => {
      expect(run({
        'lib/helper.ts': 'export const go = () => generateText({});',
        'app/api/x/route.ts': "import { go } from '@/lib/helper'; await canConsumeAI(u); go();",
      })).toEqual([]);
    });

    it('flags a helper once ANY caller is ungated, however deep', () => {
      expect(run({
        'lib/helper.ts': 'export const go = () => generateText({});',
        'lib/middle.ts': "import { go } from './helper'; export const mid = go;",
        'app/api/gated/route.ts': "import { go } from '@/lib/helper'; await reserveMemoryCall(u, {}); go();",
        'app/api/ungated/route.ts': "import { mid } from '@/lib/middle'; mid();",
      })).toEqual(['lib/helper.ts']);
    });

    it('does not count a type-only import as a caller', () => {
      expect(run({
        'lib/helper.ts': 'export type R = string; export const go = () => generateText({});',
        'app/api/gated/route.ts': "import { go } from '@/lib/helper'; await canConsumeAI(u); go();",
        'app/api/types/route.ts': "import type { R } from '@/lib/helper';",
      })).toEqual([]);
    });

    it('does not count a comment that mentions the gate', () => {
      expect(run({ 'lib/x.ts': stripComments('// canConsumeAI( later\nexport const go = () => streamText({});') }))
        .toEqual(['lib/x.ts']);
    });
  });

  it('SPEND-1 (partial) the memory cron runs a model and is gated (it left the ungated list)', () => {
    const cron = ROUTE_FILES.find((f) => webRelPath(f) === 'src/app/api/memory/cron/route.ts');
    expect(cron).toBeDefined();
    const scanned = routeAndDirectImports(cron!);
    expect(scanned.some(({ src }) => MODEL_CALL.test(src))).toBe(true);
    expect(ungatedModelRoutes()).not.toContain('src/app/api/memory/cron/route.ts');
    expect(Object.keys(UNGATED_BY_DESIGN)).not.toContain('src/app/api/memory/cron/route.ts');
  });

  it('the model-call scan sees the /btw side-question stream (guard is not vacuous)', () => {
    const btw = ROUTE_FILES.find((f) => apiRelPath(f) === '/api/ai/btw/route.ts');
    expect(btw).toBeDefined();
    expect(routeAndDirectImports(btw!).some(({ src }) => MODEL_CALL.test(src))).toBe(true);
  });

  it('the model-call scan sees the workflow routes run a model (their gate is required, not vacuous)', () => {
    // These run the model through executeWorkflow; if the scan stopped seeing it,
    // dropping their gate would pass this guard silently.
    for (const rel of ['/api/workflows/[workflowId]/run/route.ts', '/api/cron/workflows/route.ts', '/api/cron/task-triggers/route.ts']) {
      const file = ROUTE_FILES.find((f) => apiRelPath(f) === rel);
      expect(file, rel).toBeDefined();
      expect(routeAndDirectImports(file!).some(({ src }) => MODEL_CALL.test(src)), rel).toBe(true);
    }
  });

  it('found the route files (guard is actually scanning something)', () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(0);
    // sanity: the chat route is in the set
    expect(ROUTE_FILES.some((f) => apiRelPath(f).endsWith('/ai/chat/route.ts'))).toBe(true);
  });

  it('SPEND-1 (partial) every canConsumeAI call a route makes, or delegates to, names the wallet it spends', () => {
    // The gate takes the session's drive and the chosen source (or PERSONAL_SPEND for a
    // call with no drive) and reserves on exactly the wallet that resolves to. A call that
    // passed no spend target would have no wallet to name; the type makes `spend` required,
    // and this keeps a cast or an untyped options bag from slipping one through.
    const offenders: string[] = [];
    let gateCalls = 0;
    for (const file of ROUTE_FILES) {
      for (const { path, src } of routeAndDirectImports(file)) {
        for (const slice of gateCallSlices(src)) {
          gateCalls++;
          const namesSpend = /\bspend\b/.test(slice);
          // An options variable (`canConsumeAI(userId, tier, opts)`) must be built with a spend target.
          const passesOptionsVariable = /,\s*\w+\s*\)\s*$/.test(slice) && /\bspend:/.test(src);
          if (!namesSpend && !passesOptionsVariable) offenders.push(relative(API_DIR, path));
        }
      }
    }
    expect(gateCalls).toBeGreaterThan(5);
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('every interactive canConsumeAI caller passes maxInFlight', () => {
    const offenders: string[] = [];
    for (const file of ROUTE_FILES) {
      const rel = apiRelPath(file);
      // Cron routes are system-scheduled (one invocation per tick, no user fan-out), so
      // the concurrency cap doesn't apply — they're exempt by design.
      if (rel.includes('/cron/')) continue;
      const src = readFileSync(file, 'utf8');
      for (const slice of gateCallSlices(src)) {
        if (!slice.includes('maxInFlight')) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every OpenRouter onFinish that captures cost also captures the generation id(s)', () => {
    const offenders: string[] = [];
    for (const file of ROUTE_FILES) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('extractOpenRouterCostDollars') && !src.includes('extractOpenRouterGenerationIds')) {
        offenders.push(apiRelPath(file));
      }
    }
    // A row billed on OpenRouter cost but missing its generation id can never be
    // reconciled against the authoritative /generation cost — capture must travel together.
    expect(offenders).toEqual([]);
  });
});

// ─── Every module that runs a model, not only routes ─────────────────────────────────────
//
// What this proves, exactly: in apps/web/src, every FILE that imports an AI SDK entry point or
// fetches a provider's API either calls a gate itself or is pinned to ONE caller file that
// calls a gate and imports it; in apps/realtime/src, every file that opens the OpenAI
// Realtime socket or imports an AI SDK entry point is pinned the same way, and the pinned
// caller takes its meter's hold before it attaches. KNOWN_LIMITS below is what it does NOT
// prove; it is pinned so a limit cannot quietly grow or be forgotten.
const KNOWN_LIMITS = [
  'per file, not per call: a second, ungated model call inside a file that already calls a gate passes',
  'a pinned module is checked against ONE caller that gates and imports it; any other caller of it is not checked',
  'scans apps/web/src and apps/realtime/src only: packages/* and the other apps are not scanned (none runs a model today)',
  'a gate call is matched by name: the guard does not prove it runs before the model call, only that the file makes it',
] as const;

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test') continue;
      out.push(...allSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}


/** The AI SDK entry points that run a model. */
const MODEL_ENTRY_POINTS = new Set([
  'streamText', 'generateText', 'generateObject', 'streamObject', 'embed', 'embedMany',
  'generateImage', 'experimental_generateImage', 'experimental_transcribe', 'experimental_generateSpeech',
]);

/**
 * Runs a model: imports an AI SDK entry point as a value (a call can hide behind an injected
 * parameter, as the /btw side question's `streamText: stream = streamText` does, so the
 * import is the signal, not the call), or calls a provider's HTTP API directly.
 */
function runsModel(src: string): boolean {
  for (const match of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]ai['"]/g)) {
    const names = match[1].split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type '));
    if (names.some((n) => MODEL_ENTRY_POINTS.has(n.split(/\s+as\s+/)[0].trim()))) return true;
  }
  // Free lookups (the model list, a generation's recorded cost) run no model.
  return /fetch\(\s*['"`]https:\/\/(?:api\.openai\.com|openrouter\.ai\/api)\/v1\/(?!models\b|generation\b)/.test(src);
}

/** The credit gate or one of its wrappers — each reserves through canConsumeAI before the call. */
const MODULE_GATE = /\b(?:canConsumeAI|gateUserCall|reserveMemoryCall|acquire(?:User|Workflow|Mention)CreditHold)\(/;

/**
 * Modules that run a model without calling the gate themselves because EVERY caller gates
 * first. Each names the one file that takes that gate and imports the module; the guard
 * checks both, so an entry cannot outlive the gate it relies on. Pinned exactly: a new
 * module that runs a model either gates its own call or is argued onto this list in review.
 */
const GATED_BY_CALLER: Record<string, { gatedIn: string; reason: string }> = {
  'src/lib/ai/btw/side-question.ts': {
    gatedIn: 'src/app/api/ai/btw/route.ts',
    reason: 'runs only from POST /api/ai/btw, which gates with canConsumeAI and settles the hold once',
  },
  'src/lib/ai/core/image-generation.ts': {
    gatedIn: 'src/lib/ai/tools/image-generation-tools.ts',
    reason: 'runs only from the generate_image tool, which gates with canConsumeAI on its turn\'s spend before generating',
  },
  'src/lib/ai/tools/agent-communication-tools.ts': {
    gatedIn: 'src/lib/channels/agent-mention-responder.ts',
    reason: 'executeAskAgent\'s only caller is the channel mention responder, which takes acquireMentionCreditHold (automationSpend on the drive) before it; it settles on that hold\'s walletId',
  },
  'src/lib/integrations/zoom/extract-action-items.ts': {
    gatedIn: 'src/lib/integrations/zoom/process-webhook.ts',
    reason: 'called only from processZoomWebhook, which reserves the destination drive\'s payer (acquireUserCreditHold) before either enrichment call',
  },
  'src/lib/integrations/zoom/generate-summary.ts': {
    gatedIn: 'src/lib/integrations/zoom/process-webhook.ts',
    reason: 'called only from processZoomWebhook, which reserves the destination drive\'s payer (acquireUserCreditHold) before either enrichment call',
  },
  'src/lib/workflows/workflow-executor.ts': {
    gatedIn: 'src/lib/workflows/workflow-credit-gate.ts',
    reason: 'every run is admitted by acquireWorkflowCreditHold or carries the creditSpend its trigger executor reserved with canConsumeAI; a run with neither fails closed (automationRunUnreserved)',
  },
};

const moduleSources = () => allSourceFiles(SRC_DIR).map((path) => ({ rel: webRelPath(path), src: stripComments(readFileSync(path, 'utf8')) }));

describe('AI gate call-site guards: every module that runs a model', () => {
  const modules = moduleSources();
  const modelModules = modules.filter(({ src }) => runsModel(src));

  it('SPEND-1 (partial) every module that runs a model gates the call itself or is pinned to the gate its callers take', () => {
    const offenders = modelModules
      .filter(({ rel, src }) => !MODULE_GATE.test(src) && !(rel in GATED_BY_CALLER))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('the gated-by-caller list is exactly these modules, each still running a model with no gate of its own', () => {
    expect(Object.keys(GATED_BY_CALLER).sort()).toEqual([
      'src/lib/ai/btw/side-question.ts',
      'src/lib/ai/core/image-generation.ts',
      'src/lib/ai/tools/agent-communication-tools.ts',
      'src/lib/integrations/zoom/extract-action-items.ts',
      'src/lib/integrations/zoom/generate-summary.ts',
      'src/lib/workflows/workflow-executor.ts',
    ]);
    const bySrc = new Map(modules.map(({ rel, src }) => [rel, src]));
    for (const rel of Object.keys(GATED_BY_CALLER)) {
      const src = bySrc.get(rel);
      expect(src, rel).toBeDefined();
      expect(runsModel(src!), `${rel} no longer runs a model: remove it`).toBe(true);
      expect(MODULE_GATE.test(src!), `${rel} now gates itself: remove it`).toBe(false);
    }
  });

  it('each pinned module\'s caller takes the gate and imports the module', () => {
    const bySrc = new Map(modules.map(({ rel, src }) => [rel, src]));
    for (const [rel, { gatedIn, reason }] of Object.entries(GATED_BY_CALLER)) {
      const caller = bySrc.get(gatedIn);
      expect(caller, gatedIn).toBeDefined();
      expect(MODULE_GATE.test(caller!), `${gatedIn} takes no gate`).toBe(true);
      const moduleName = rel.replace(/^.*\//, '').replace(/\.tsx?$/, '');
      expect(new RegExp(`['"][^'"]*/${moduleName}['"]`).test(caller!), `${gatedIn} does not import ${rel}`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('its known limits are exactly these, each stated', () => {
    expect(KNOWN_LIMITS).toHaveLength(4);
    for (const limit of KNOWN_LIMITS) expect(limit.length).toBeGreaterThan(40);
  });

  it('the module scan sees the model calls it must (guard is not vacuous)', () => {
    const rels = modelModules.map(({ rel }) => rel);
    for (const expected of [
      'src/lib/ai/chat-pipeline/page-chat-turn.ts',
      'src/lib/ai/core/compaction/compaction-service.ts',
      'src/lib/memory/discovery-service.ts',
      'src/lib/ai/btw/side-question.ts',
      'src/app/api/voice/synthesize/route.ts',
    ]) {
      expect(rels, expected).toContain(expected);
    }
  });
});

// ─── apps/realtime: the Realtime voice transport ─────────────────────────────────────────

const REALTIME_SRC = join(process.cwd(), '..', 'realtime', 'src');
const realtimeRel = (file: string) => relative(join(process.cwd(), '..', '..'), file).split(sep).join('/');

/** Opens the OpenAI Realtime socket, or runs a model through the AI SDK. */
const runsRealtimeModel = (src: string) => /['"`]wss:\/\/api\.openai\.com\/v1\/realtime/.test(src) || runsModel(src);

/**
 * apps/realtime modules that run a model, each pinned to the caller that takes the meter's
 * hold (canConsumeAI inside startCallMeter) before the socket attaches.
 */
const REALTIME_GATED_BY_CALLER: Record<string, { gatedIn: string; reason: string }> = {
  'apps/realtime/src/voice/realtime-call-session.ts': {
    gatedIn: 'apps/realtime/src/voice/attach-handler.ts',
    reason: 'the Realtime socket is attached only by the attach handler, after startMeter took the opening hold on the call\'s resolved spend; every later window re-holds through canConsumeAI or ends the call',
  },
};

describe('AI gate call-site guards: apps/realtime', () => {
  const modules = allSourceFiles(REALTIME_SRC).map((path) => ({ rel: realtimeRel(path), src: stripComments(readFileSync(path, 'utf8')) }));
  const bySrc = new Map(modules.map(({ rel, src }) => [rel, src]));

  it('SPEND-1 (partial) every apps/realtime module that runs a model is pinned to a caller that meters it first', () => {
    const offenders = modules
      .filter(({ rel, src }) => runsRealtimeModel(src) && !MODULE_GATE.test(src) && !(rel in REALTIME_GATED_BY_CALLER))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
    expect(modules.filter(({ src }) => runsRealtimeModel(src)).map(({ rel }) => rel)).toEqual(Object.keys(REALTIME_GATED_BY_CALLER));
  });

  it('the pinned caller takes the meter\'s hold BEFORE it attaches the socket, and the meter gates through canConsumeAI', () => {
    for (const [rel, { gatedIn, reason }] of Object.entries(REALTIME_GATED_BY_CALLER)) {
      const caller = bySrc.get(gatedIn);
      expect(caller, gatedIn).toBeDefined();
      const moduleName = rel.replace(/^.*\//, '').replace(/\.tsx?$/, '');
      expect(new RegExp(`['"][^'"]*/${moduleName}['"]`).test(caller!), `${gatedIn} does not import ${rel}`).toBe(true);
      const meterAt = caller!.indexOf('deps.startMeter(');
      const attachAt = caller!.indexOf('deps.attach(');
      expect(meterAt, 'startMeter call').toBeGreaterThan(-1);
      expect(attachAt, 'attach call').toBeGreaterThan(meterAt);
      expect(reason.length).toBeGreaterThan(20);
    }
    const meter = bySrc.get('apps/realtime/src/voice/call-metering.ts');
    expect(meter).toBeDefined();
    expect(meter).toMatch(/gate = canConsumeAI/);
    expect(meter!.indexOf('await gate(userId')).toBeGreaterThan(-1);
  });
});
