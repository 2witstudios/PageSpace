/**
 * Pure step validation, shared by API save-time and executor run-time.
 *
 * Purity contract: the tool allowlist and zod schemas are INJECTED — this
 * module must not import the tool registry (tool modules perform I/O at
 * import time). The shell builds `schemas` from `pageSpaceTools`.
 *
 * Honest partial validation: args containing `$payload` refs cannot be
 * statically parsed against the tool schema (refs resolve at run time), so
 * save-time validates ref path syntax only and the executor re-parses after
 * resolution. Ref-free args are fully parsed here.
 */

import type { WorkflowStep, WorkflowToolStep } from '@pagespace/db/schema/workflows';
import { isPayloadRef, validatePayloadPath } from './resolve-step-args';
import { MAX_WORKFLOW_STEPS } from './step-plan';

export type SchemaLike = {
  safeParse(value: unknown): { success: boolean; error?: unknown };
};

export type ToolStepValidationOptions = {
  allowlist: readonly string[];
  schemas: Record<string, SchemaLike>;
};

export type ToolStepValidation =
  | { ok: true; refs: string[]; fullyValidated: boolean }
  | { ok: false; error: string };

type RefCollection = { ok: true; refs: string[] } | { ok: false; error: string };

function collectRefs(value: unknown, refs: string[]): RefCollection {
  if (isPayloadRef(value)) {
    if (Object.keys(value).length !== 1) {
      return { ok: false, error: 'malformed $payload reference: extra keys beside $payload' };
    }
    const pathCheck = validatePayloadPath(value.$payload);
    if (!pathCheck.ok) return pathCheck;
    refs.push(String(value.$payload));
    return { ok: true, refs };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = collectRefs(item, refs);
      if (!result.ok) return result;
    }
    return { ok: true, refs };
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      const result = collectRefs(item, refs);
      if (!result.ok) return result;
    }
    return { ok: true, refs };
  }
  return { ok: true, refs };
}

export function validateToolStep(
  step: WorkflowToolStep,
  options: ToolStepValidationOptions
): ToolStepValidation {
  if (!options.allowlist.includes(step.toolName)) {
    return {
      ok: false,
      error: `tool "${step.toolName}" is not deterministically invocable (allowlist: ${options.allowlist.join(', ')})`,
    };
  }
  const schema = options.schemas[step.toolName];
  if (!schema) {
    return {
      ok: false,
      error: `no input schema available for tool "${step.toolName}" (registry drift)`,
    };
  }

  const collected = collectRefs(step.args, []);
  if (!collected.ok) return collected;

  if (collected.refs.length === 0) {
    const parsed = schema.safeParse(step.args);
    if (!parsed.success) {
      return { ok: false, error: `args do not match the "${step.toolName}" input schema` };
    }
    return { ok: true, refs: [], fullyValidated: true };
  }

  return { ok: true, refs: collected.refs, fullyValidated: false };
}

export type StepsValidationOptions = ToolStepValidationOptions & {
  workflowAgentPageId: string | null;
};

export type StepsValidation = { ok: true } | { ok: false; error: string };

export function validateSteps(
  steps: readonly WorkflowStep[],
  options: StepsValidationOptions
): StepsValidation {
  if (steps.length === 0) {
    return { ok: false, error: 'a workflow needs at least one step' };
  }
  if (steps.length > MAX_WORKFLOW_STEPS) {
    return { ok: false, error: `a workflow may have at most ${MAX_WORKFLOW_STEPS} steps` };
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = `step ${i + 1}`;
    if (step.kind === 'ai') {
      if (step.prompt.trim().length === 0) {
        return { ok: false, error: `${label}: ai step prompt must not be empty` };
      }
      if (!step.agentPageId && !options.workflowAgentPageId) {
        return {
          ok: false,
          error: `${label}: ai step needs an agentPageId (on the step or the workflow)`,
        };
      }
    } else {
      const result = validateToolStep(step, options);
      if (!result.ok) {
        return { ok: false, error: `${label}: ${result.error}` };
      }
    }
  }
  return { ok: true };
}

/**
 * True when any tool step references the trigger payload — used for the
 * save-time warning on cron-only workflows (refs strict-fail without a
 * payload at run time).
 */
export function stepsRequirePayload(steps: readonly WorkflowStep[]): boolean {
  for (const step of steps) {
    if (step.kind !== 'tool') continue;
    const collected = collectRefs(step.args, []);
    if (collected.ok && collected.refs.length > 0) return true;
  }
  return false;
}
