/**
 * Pure payload-reference resolution for deterministic workflow steps.
 *
 * A leaf value that is exactly `{ $payload: 'dot.path' }` resolves from the
 * trigger payload. References fill VALUE slots only — which fields are
 * templated, the tool name, and the arg shape are fixed configuration, so an
 * attacker-influenced payload can never redirect a step, only populate it.
 * Resolution is strict-fail: a missing path, an absent payload (cron/manual
 * runs), or a non-scalar target errors the step rather than silently
 * substituting an empty value.
 */

export const MAX_RESOLVED_STRING_LENGTH = 16 * 1024;
export const MAX_PATH_SEGMENTS = 8;
const MAX_ARGS_DEPTH = 16;

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export type ResolveArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

export type PathValidation = { ok: true; segments: string[] } | { ok: false; error: string };

/** Validate a `$payload` dot-path's syntax without resolving it. */
export function validatePayloadPath(path: unknown): PathValidation {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: '$payload reference must be a non-empty string path' };
  }
  const segments = path.split('.');
  if (segments.length > MAX_PATH_SEGMENTS) {
    return { ok: false, error: `$payload path "${path}" exceeds ${MAX_PATH_SEGMENTS} segments` };
  }
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      return { ok: false, error: `$payload path "${path}" has an invalid segment "${segment}"` };
    }
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return { ok: false, error: `$payload path "${path}" uses a forbidden segment "${segment}"` };
    }
  }
  return { ok: true, segments };
}

/**
 * True when `value` is shaped like a payload reference: a plain object whose
 * only key is `$payload`. Objects carrying `$payload` alongside other keys
 * are malformed references (callers must reject them, not treat as literals).
 */
export function isPayloadRef(value: unknown): value is { $payload: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, '$payload')
  );
}

function resolvePath(payload: unknown, segments: string[], path: string):
  | { ok: true; value: string | number | boolean }
  | { ok: false; error: string } {
  let current: unknown = payload;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { ok: false, error: `$payload path "${path}" not found in trigger payload` };
      }
      current = current[index];
    } else if (typeof current === 'object' && current !== null) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return { ok: false, error: `$payload path "${path}" not found in trigger payload` };
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { ok: false, error: `$payload path "${path}" not found in trigger payload` };
    }
  }
  if (typeof current === 'string') {
    if (current.length > MAX_RESOLVED_STRING_LENGTH) {
      return {
        ok: false,
        error: `$payload path "${path}" resolves to a string longer than ${MAX_RESOLVED_STRING_LENGTH} characters`,
      };
    }
    return { ok: true, value: current };
  }
  if (typeof current === 'number' || typeof current === 'boolean') {
    return { ok: true, value: current };
  }
  return {
    ok: false,
    error: `$payload path "${path}" resolves to an unsupported type (only string/number/boolean allowed)`,
  };
}

type WalkResult = { ok: true; value: unknown } | { ok: false; error: string };

function resolveValue(value: unknown, payload: unknown, hasPayload: boolean, depth: number): WalkResult {
  if (depth > MAX_ARGS_DEPTH) {
    return { ok: false, error: `step args nest deeper than ${MAX_ARGS_DEPTH} levels` };
  }

  if (isPayloadRef(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      return { ok: false, error: 'malformed $payload reference: extra keys beside $payload' };
    }
    const pathCheck = validatePayloadPath(value.$payload);
    if (!pathCheck.ok) return pathCheck;
    if (!hasPayload) {
      return {
        ok: false,
        error: `no trigger payload available for $payload reference "${String(value.$payload)}" (cron/manual runs carry no payload)`,
      };
    }
    const resolved = resolvePath(payload, pathCheck.segments, String(value.$payload));
    if (!resolved.ok) return resolved;
    return { ok: true, value: resolved.value };
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const result = resolveValue(item, payload, hasPayload, depth + 1);
      if (!result.ok) return result;
      out.push(result.value);
    }
    return { ok: true, value: out };
  }

  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = resolveValue(item, payload, hasPayload, depth + 1);
      if (!result.ok) return result;
      out[key] = result.value;
    }
    return { ok: true, value: out };
  }

  return { ok: true, value };
}

/**
 * Resolve every `{ $payload: 'dot.path' }` reference in `args` against the
 * trigger payload. Returns new args (input is never mutated). `payload`
 * `undefined` means "this run has no trigger payload" — any reference then
 * strict-fails.
 */
export function resolveStepArgs(
  args: Record<string, unknown>,
  payload: unknown
): ResolveArgsResult {
  const hasPayload = payload !== undefined;
  const result = resolveValue(args, payload, hasPayload, 0);
  if (!result.ok) return result;
  return { ok: true, args: result.value as Record<string, unknown> };
}
