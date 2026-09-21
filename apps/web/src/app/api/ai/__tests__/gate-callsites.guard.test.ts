/**
 * Merge guards over the AI route call sites. These are source-scan invariants: they read
 * the route files and fail the build if a regression slips in — a gate caller that forgets
 * the concurrency cap, or an OpenRouter onFinish that captures cost but not the generation
 * id the reconcile cron needs. Cheaper and more durable than hoping a reviewer notices.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

/** Resolve an `@/lib/...` import to its source file, or undefined. */
function resolveLibImport(specifier: string): string | undefined {
  const base = join(process.cwd(), 'src', specifier.slice(2));
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) => existsSync(candidate));
}

/**
 * The route plus every `@/lib/...` module it imports directly. One level deep is
 * where a route's model call hides when it is not in the route itself (the /btw
 * route streamed through `@/lib/ai/btw/side-question`), and where the gate lives
 * when a route delegates its whole turn (the chat route → the chat pipeline).
 */
function routeAndDirectLibImports(file: string): Array<{ path: string; src: string }> {
  const src = readFileSync(file, 'utf8');
  const imported = [...src.matchAll(/from\s+['"](@\/lib\/[^'"]+)['"]/g)]
    .map((match) => resolveLibImport(match[1]))
    .filter((path): path is string => path !== undefined);
  return [{ path: file, src }, ...[...new Set(imported)].map((path) => ({ path, src: readFileSync(path, 'utf8') }))];
}

/**
 * Pre-existing routes that invoke a model with no credit gate, surfaced when this
 * guard learned to look for ungated routes (it previously only checked that gate
 * CALLERS passed maxInFlight, so a route that never called the gate was invisible
 * to it — which is how /api/ai/btw shipped unmetered). Each is a known gap tracked
 * for its own fix; the list may only shrink. Adding a route here is a billing
 * decision, not a way to quiet the guard.
 */
const KNOWN_UNGATED = new Set([
  '/api/workflows/[workflowId]/run/route.ts',
  '/api/cron/workflows/route.ts',
  '/api/cron/task-triggers/route.ts',
  '/api/memory/cron/route.ts',
]);

function ungatedModelRoutes(): string[] {
  const offenders: string[] = [];
  for (const file of ROUTE_FILES) {
    const scanned = routeAndDirectLibImports(file);
    const invokesModel = scanned.some(({ src }) => MODEL_CALL.test(src));
    const gated = scanned.some(({ src }) => src.includes(GATE_CALL));
    if (invokesModel && !gated) offenders.push(apiRelPath(file));
  }
  return offenders;
}

describe('AI gate call-site guards', () => {
  it('every route that creates an AI provider or runs a model passes the credit gate', () => {
    const offenders = ungatedModelRoutes().filter((rel) => !KNOWN_UNGATED.has(rel));
    // A model call with no canConsumeAI = unmetered spend: no hold, no balance check,
    // no in-flight cap. Gate before the call and settle the hold via trackUsage.
    expect(offenders).toEqual([]);
  });

  it('the known-ungated list only holds routes that are still ungated (it may only shrink)', () => {
    const stillUngated = new Set(ungatedModelRoutes());
    expect([...KNOWN_UNGATED].filter((rel) => !stillUngated.has(rel))).toEqual([]);
  });

  it('the model-call scan sees the /btw side-question stream (guard is not vacuous)', () => {
    const btw = ROUTE_FILES.find((f) => apiRelPath(f) === '/api/ai/btw/route.ts');
    expect(btw).toBeDefined();
    expect(routeAndDirectLibImports(btw!).some(({ src }) => MODEL_CALL.test(src))).toBe(true);
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
