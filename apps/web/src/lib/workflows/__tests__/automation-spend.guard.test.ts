/**
 * Merge guard for SPEND-6: every entry point that runs a model with no person present —
 * workflows (manual, cron), task, calendar, Zoom and page-webhook triggers, and channel
 * mentions — names its drive to the credit gate (automationSpend), never PERSONAL_SPEND.
 * Source-scan, like gate-callsites.guard: a new caller of executeWorkflow, or a gate
 * module that stops naming the drive, fails here and has to be argued in review.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// vitest runs with cwd = apps/web.
const SRC = join(process.cwd(), 'src');
const rel = (file: string) => relative(SRC, file).split(sep).join('/');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((path) => ({ path: rel(path), src: stripComments(readFileSync(path, 'utf8')) }));
const read = (path: string) => {
  const file = FILES.find((f) => f.path === path);
  if (!file) throw new Error(`missing ${path}`);
  return file.src;
};

/**
 * Every caller of executeWorkflow, and how it is gated. Pinned literally: a new caller must
 * be added here with the gate that names its drive.
 */
const EXECUTE_WORKFLOW_CALLERS: Record<string, 'admit' | 'creditSpend'> = {
  'app/api/workflows/[workflowId]/run/route.ts': 'admit',
  'app/api/cron/workflows/route.ts': 'admit',
  'app/api/cron/task-triggers/route.ts': 'admit',
  'lib/workflows/task-trigger-helpers.ts': 'admit',
  'lib/workflows/calendar-trigger-executor.ts': 'creditSpend',
  'lib/integrations/zoom/webhook-trigger-executor.ts': 'creditSpend',
  'lib/webhooks/page-webhook-trigger-executor.ts': 'creditSpend',
};

/** The modules that take an automation's credit gate: each names the drive, never a person. */
const AUTOMATION_GATES = [
  'lib/workflows/workflow-credit-gate.ts',
  'lib/workflows/calendar-trigger-executor.ts',
  'lib/integrations/zoom/webhook-trigger-executor.ts',
  'lib/webhooks/page-webhook-trigger-executor.ts',
  'lib/channels/mention-credit-gate.ts',
];

describe('SPEND-6 automation entry points', () => {
  it('SPEND-6 (partial) every caller of executeWorkflow is listed, and each passes the gate that names its drive', () => {
    const callers = FILES
      .filter((f) => f.path !== 'lib/workflows/workflow-executor.ts' && /\bexecuteWorkflow\(/.test(f.src))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual(Object.keys(EXECUTE_WORKFLOW_CALLERS).sort());

    for (const [path, via] of Object.entries(EXECUTE_WORKFLOW_CALLERS)) {
      const src = read(path);
      const calls = [...src.matchAll(/\bexecuteWorkflow\(([^;]*)/g)].map((m) => m[1]);
      for (const call of calls) {
        expect(call, path).toMatch(via === 'admit' ? /admit:\s*creditAdmission\(/ : /creditSpend:/);
      }
    }
  });

  it('SPEND-6 (partial) every automation gate names its drive (automationSpend) and never PERSONAL_SPEND', () => {
    for (const path of AUTOMATION_GATES) {
      const src = read(path);
      expect(src, path).toMatch(/\bautomationSpend\(/);
      expect(src, path).not.toMatch(/\bPERSONAL_SPEND\b/);
      expect(src, path).not.toMatch(/\bdriveSpend\(/);
    }
  });

  it('SPEND-6 (partial) channel mentions reach the model only through the mention credit gate', () => {
    const responder = read('lib/channels/agent-mention-responder.ts');
    const gateAt = responder.indexOf('acquireMentionCreditHold(');
    const askAt = responder.indexOf('await askAgentExecute(');
    expect(gateAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(gateAt);
  });

  it('the scan sees the executor itself (guard is not vacuous)', () => {
    expect(read('lib/workflows/workflow-executor.ts')).toMatch(/export async function executeWorkflow\(/);
  });
});
