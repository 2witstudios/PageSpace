/**
 * Merge guards over the AI route call sites. These are source-scan invariants: they read
 * the route files and fail the build if a regression slips in — a gate caller that forgets
 * the concurrency cap, or an OpenRouter onFinish that captures cost but not the generation
 * id the reconcile cron needs. Cheaper and more durable than hoping a reviewer notices.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

// vitest runs with cwd = apps/web; the AI routes live under src/app/api.
const API_DIR = join(process.cwd(), 'src/app/api');

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
const GATE_CALL = 'canConsumeAI(';

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
 * Routes that run a model without a PRE-call gate by design. Pinned exactly below:
 * adding a route here is a billing decision, not a way to quiet the guard. There
 * is no "known gap" list any more — the workflow routes that were on one (manual
 * run, the workflows cron, the task-triggers cron) now take the credit hold via
 * `@/lib/workflows/workflow-credit-gate`, and a new ungated route fails outright.
 */
const UNGATED_BY_DESIGN: Record<string, string> = {
  '/api/memory/cron/route.ts':
    'HMAC-signed system cron (validateSignedCronRequest), not user-reachable, so no user fan-out; runs only for paying tiers (MEMORY_PAYING_TIERS), once per user per day; every model call still records and debits usage via AIMonitoring.trackUsage (source: memory)',
};

function ungatedModelRoutes(): string[] {
  const offenders: string[] = [];
  for (const file of ROUTE_FILES) {
    const scanned = routeAndDirectImports(file);
    const invokesModel = scanned.some(({ src }) => MODEL_CALL.test(src));
    const gated = scanned.some(({ src }) => src.includes(GATE_CALL));
    if (invokesModel && !gated) offenders.push(apiRelPath(file));
  }
  return offenders;
}

describe('AI gate call-site guards', () => {
  it('every route that creates an AI provider or runs a model passes the credit gate', () => {
    const offenders = ungatedModelRoutes().filter((rel) => !(rel in UNGATED_BY_DESIGN));
    // A model call with no canConsumeAI = unmetered spend: no hold, no balance check,
    // no in-flight cap. Gate before the call and settle the hold via trackUsage.
    expect(offenders).toEqual([]);
  });

  it('the ungated list is exactly these routes, each with a reason', () => {
    // Pinned literally: growing the list must fail here and be argued in review.
    expect(Object.keys(UNGATED_BY_DESIGN)).toEqual(['/api/memory/cron/route.ts']);
    for (const reason of Object.values(UNGATED_BY_DESIGN)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('every listed route is still ungated (a fixed route must leave the list)', () => {
    const stillUngated = new Set(ungatedModelRoutes());
    expect(Object.keys(UNGATED_BY_DESIGN).filter((rel) => !stillUngated.has(rel))).toEqual([]);
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
