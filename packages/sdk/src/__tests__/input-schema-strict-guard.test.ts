/**
 * Registry-wide consistency guard (W6 minor): every operation's `inputSchema`
 * must reject an unrecognized field rather than silently stripping it, so a
 * caller's typo'd or misplaced field (e.g. `position` sent to `tasks.update`
 * instead of `tasks.reorder`) surfaces as a validation error instead of a
 * silently-wrong request. Detected structurally — parsing a bogus-only
 * object and checking for zod's `unrecognized_keys` issue, which strict mode
 * raises independent of whatever other required-field issues also fire —
 * rather than by hand-building valid input per operation.
 *
 * `agents.list` is the sole documented exception: it deliberately still
 * accepts (and strips) the old MCP tool's decorative `agentPath`/`driveSlug`
 * fields for backward compatibility (see its request-shape test).
 */
import { describe, expect, it } from 'vitest';
import type { Operation } from '../registry/define.js';
import { loadAllOperations } from './support/load-operations.js';

/** Deliberately not `.strict()` — see file header. */
const ALLOWED_NON_STRICT = new Set(['agents.list']);

const PROBE_FIELD = '__unrecognized_field_probe__';

function rejectsUnrecognizedField(op: Operation): boolean {
  const result = op.inputSchema.safeParse({ [PROBE_FIELD]: 'probe' });
  if (result.success) return false;
  return result.error.issues.some((issue) => issue.code === 'unrecognized_keys');
}

describe('registry input schemas — unrecognized-field guard', () => {
  const allOps = loadAllOperations();

  it('discovers operations to check (guards the test itself against an empty glob)', () => {
    expect(allOps.length).toBeGreaterThan(0);
  });

  it('every operation not on the allowlist rejects an unrecognized input field', () => {
    const offenders = allOps.filter((op) => !ALLOWED_NON_STRICT.has(op.name) && !rejectsUnrecognizedField(op)).map((op) => op.name);
    expect(offenders).toEqual([]);
  });

  it('the allowlist contains only operations that actually still accept unrecognized fields (no stale entries)', () => {
    const staleAllowlistEntries = [...ALLOWED_NON_STRICT].filter((name) => {
      const op = allOps.find((candidate) => candidate.name === name);
      return op !== undefined && rejectsUnrecognizedField(op);
    });
    expect(staleAllowlistEntries).toEqual([]);
  });
});
