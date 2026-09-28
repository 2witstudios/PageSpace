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
/**
 * A route's model call is gated when it, or a module it imports directly, calls the gate —
 * canConsumeAI itself, or reserveMemoryCall, which each memory service calls before its own
 * model call and which reserves through canConsumeAI (memory-credit.ts, unit-tested).
 */
const ROUTE_GATE_CALLS = [GATE_CALL, 'reserveMemoryCall('];

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
  // Empty. The memory cron was here ("records and debits usage"), which meant no balance
  // check and no hold, so an out-of-credit person was pushed into debt every night. Each
  // memory model call now reserves the person's own credits first (reserveMemoryCall).
};

function ungatedModelRoutes(): string[] {
  const offenders: string[] = [];
  for (const file of ROUTE_FILES) {
    const scanned = routeAndDirectImports(file);
    const invokesModel = scanned.some(({ src }) => MODEL_CALL.test(src));
    const gated = scanned.some(({ src }) => ROUTE_GATE_CALLS.some((gate) => src.includes(gate)));
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
    expect(Object.keys(UNGATED_BY_DESIGN)).toEqual([]);
    for (const reason of Object.values(UNGATED_BY_DESIGN)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('every listed route is still ungated (a fixed route must leave the list)', () => {
    const stillUngated = new Set(ungatedModelRoutes());
    expect(Object.keys(UNGATED_BY_DESIGN).filter((rel) => !stillUngated.has(rel))).toEqual([]);
  });

  it('SPEND-1 (partial) the memory cron runs a model and is gated (it left the ungated list)', () => {
    const cron = ROUTE_FILES.find((f) => apiRelPath(f) === '/api/memory/cron/route.ts');
    expect(cron).toBeDefined();
    const scanned = routeAndDirectImports(cron!);
    expect(scanned.some(({ src }) => MODEL_CALL.test(src))).toBe(true);
    expect(ungatedModelRoutes()).not.toContain('/api/memory/cron/route.ts');
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

const SRC_DIR = join(process.cwd(), 'src');

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

/** Relative to apps/web, forward slashes. */
const webRelPath = (file: string) => relative(process.cwd(), file).split(sep).join('/');

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
