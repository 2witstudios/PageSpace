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
 * hold through it for a whole domain. Each wrapper is pinned to its module below, and a
 * test proves every one of those modules really calls `canConsumeAI` — so naming a
 * function here cannot make an ungated call look gated.
 */
const GATE_WRAPPERS: Record<string, string> = {
  acquireUserCreditHold: 'src/lib/ai/core/user-credit-hold.ts',
  acquireWorkflowCreditHold: 'src/lib/workflows/workflow-credit-gate.ts',
  creditAdmission: 'src/lib/workflows/workflow-credit-gate.ts',
  withMemoryCreditHold: 'src/lib/memory/memory-credit-gate.ts',
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
    "ask_agent's nested sub-agent call. It runs only as a tool's execute inside a parent model call that already passed its gate — the chat turns, v1 completions, page-agent consult, workflow runs (creditAdmission), channel-mention replies (acquireUserCreditHold) and voice calls (gated at the realtime handshake). The nested call debits its own usage via AIMonitoring.trackUsage. ai-tools imports it only to assemble the tool registry, which runs nothing.",
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

  it('every gate wrapper is defined where pinned and really calls canConsumeAI', () => {
    for (const [name, rel] of Object.entries(GATE_WRAPPERS)) {
      const src = PRODUCTION_SOURCES.get(join(WEB_DIR, rel));
      expect(src, rel).toBeDefined();
      expect(src, `${rel} defines ${name}`).toMatch(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`));
      expect(src, `${rel} calls canConsumeAI`).toMatch(/(?<!function\s)\bcanConsumeAI\s*\(/);
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
        'app/api/gated/route.ts': "import { go } from '@/lib/helper'; await withMemoryCreditHold(u, 1, go);",
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
