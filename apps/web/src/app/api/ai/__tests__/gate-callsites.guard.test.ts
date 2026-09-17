/**
 * Merge guards over the AI route call sites. These are source-scan invariants: they read
 * the route files and fail the build if a regression slips in — a gate caller that forgets
 * the concurrency cap, or an OpenRouter onFinish that captures cost but not the generation
 * id the reconcile cron needs. Cheaper and more durable than hoping a reviewer notices.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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

describe('AI gate call-site guards', () => {
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

/**
 * Workflow runs are gated INSIDE executeWorkflow (Agent Signup Phase 1b / D-33):
 * the manual run route and both crons once called it with no credit gate, so a
 * zero-balance account — and any unclaimed agent — could schedule free AI. The
 * gate now lives in the executor; these guards keep it there and make every new
 * entry point a conscious, reviewed addition.
 */
describe('workflow run gate guards', () => {
  const SRC_DIR = join(process.cwd(), 'src');
  const EXECUTOR = 'lib/workflows/workflow-executor.ts';

  const allSourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...allSourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  };
  const srcRel = (file: string) => relative(SRC_DIR, file).split(sep).join('/');
  const SOURCE_FILES = allSourceFiles(SRC_DIR);

  // Every caller of executeWorkflow. Adding one means reading the gate policy
  // in lib/workflows/core/workflow-gate-options.ts and listing it here.
  const KNOWN_ENTRY_POINTS = [
    'app/api/cron/task-triggers/route.ts',
    'app/api/cron/workflows/route.ts',
    'app/api/workflows/[workflowId]/run/route.ts',
    'lib/integrations/zoom/webhook-trigger-executor.ts',
    'lib/webhooks/page-webhook-trigger-executor.ts',
    'lib/workflows/calendar-trigger-executor.ts',
    'lib/workflows/task-trigger-helpers.ts',
  ];

  it('every executeWorkflow entry point is enumerated', () => {
    const callers = SOURCE_FILES.filter(
      (f) => srcRel(f) !== EXECUTOR && readFileSync(f, 'utf8').includes('executeWorkflow('),
    ).map(srcRel).sort();
    expect(callers).toEqual(KNOWN_ENTRY_POINTS);
  });

  it('executeWorkflow gates credit before claiming the run or dispatching any model call, and releases the hold in finally', () => {
    const src = readFileSync(join(SRC_DIR, EXECUTOR), 'utf8');
    const start = src.indexOf('export async function executeWorkflow(');
    const body = src.slice(start, src.indexOf('\nasync function recordRefusal(', start));
    const gate = body.indexOf('await acquireWorkflowCredit(input)');
    expect(gate).toBeGreaterThan(-1);
    // Before the claim: a transient refusal must leave no workflow_runs row.
    expect(gate).toBeLessThan(body.indexOf('.insert(workflowRuns)'));
    expect(gate).toBeLessThan(body.indexOf('runStepChain('));
    expect(gate).toBeLessThan(body.indexOf('runExecution('));
    const fin = body.lastIndexOf('} finally {');
    expect(fin).toBeGreaterThan(gate);
    expect(body.slice(fin).includes('await releaseHold(holdId)')).toBe(true);
  });

  it('no entry point takes its own credit gate or hold (the executor holds once for the whole run)', () => {
    const offenders = KNOWN_ENTRY_POINTS.filter((rel) => {
      const src = readFileSync(join(SRC_DIR, rel), 'utf8');
      return src.includes('canConsumeAI(') || src.includes('releaseHold(');
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * Every place that resolves an AI provider spends money. Each must gate credit
 * in the same file, or be on this list with the reason its spend is gated
 * upstream. A new provider call fails here until someone decides which.
 */
describe('AI provider resolution is credit-gated', () => {
  const SRC_DIR = join(process.cwd(), 'src');
  const GATE_CALLS = ['canConsumeAI(', 'acquireWorkflowCredit(', 'withZoomAiCredit('];
  const GATED_UPSTREAM: Record<string, string> = {
    'lib/ai/core/provider-factory.ts': 'defines createAIProvider',
    'lib/ai/core/compaction/compaction-service.ts': 'runs after a gated chat turn, on that turn’s conversation',
    'lib/ai/tools/agent-communication-tools.ts': 'ask_agent runs inside an already-gated parent request',
    'lib/memory/compaction-service.ts': 'memory cron: paying tiers only (MEMORY_PAYING_TIERS)',
    'lib/memory/discovery-service.ts': 'memory cron: paying tiers only (MEMORY_PAYING_TIERS)',
    'lib/memory/integration-service.ts': 'memory cron: paying tiers only (MEMORY_PAYING_TIERS)',
  };

  const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') out.push(...sourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  };

  it('every createAIProvider caller gates credit in-file or is listed with its upstream gate', () => {
    const offenders = sourceFiles(SRC_DIR)
      .map((file) => ({ rel: relative(SRC_DIR, file).split(sep).join('/'), src: readFileSync(file, 'utf8') }))
      .filter(({ src }) => src.includes('createAIProvider('))
      .filter(({ rel, src }) => !(rel in GATED_UPSTREAM) && !GATE_CALLS.some((call) => src.includes(call)))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('the Zoom transcript enrichments gate through withZoomAiCredit', () => {
    for (const rel of ['lib/integrations/zoom/generate-summary.ts', 'lib/integrations/zoom/extract-action-items.ts']) {
      expect(readFileSync(join(SRC_DIR, rel), 'utf8')).toMatch(/withZoomAiCredit\(/);
    }
  });
});
