/**
 * Agent Signup Phase 2b leaf 1 — no credential hash ever reaches a log.
 *
 * drizzle-orm 0.45.2 builds `DrizzleQueryError` as
 * `Failed query: ${query}\nparams: ${params}`, and a pg unique violation's
 * `detail` echoes the duplicate key (`Key ("secretHash")=(<hash>) already
 * exists.`). Logging either one writes the bound hash into the log. These
 * tests build the REAL wrapper shape, not a flat stand-in.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { redactDbError, isDatabaseError } from '../db-error-redaction';

const SECRET_HASH = 'a3f1c9e2b7d4a3f1c9e2b7d4a3f1c9e2b7d4a3f1c9e2b7d4a3f1c9e2b7d4a3f1';
const CLAIM_HASH = '0b9e1d7c5a3f0b9e1d7c5a3f0b9e1d7c5a3f0b9e1d7c5a3f0b9e1d7c5a3f0b9e';

function pgUniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint "agent_identities_secretHash_unique"'), {
    code: '23505',
    constraint: 'agent_identities_secretHash_unique',
    detail: `Key ("secretHash")=(${SECRET_HASH}) already exists.`,
    table: 'agent_identities',
  });
}

function drizzleInsertFailure(): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "agent_identities" ("userId", "secretHash", "claimTokenHash") values ($1, $2, $3)',
    ['user_1', SECRET_HASH, CLAIM_HASH],
    pgUniqueViolation(),
  );
}

describe('redactDbError', () => {
  it('given a drizzle-wrapped unique violation, should report the pg code and constraint from the cause', () => {
    const redacted = redactDbError(drizzleInsertFailure());

    expect(redacted).toEqual({
      errorName: 'DrizzleQueryError',
      code: '23505',
      constraint: 'agent_identities_secretHash_unique',
    });
  });

  it('given a drizzle-wrapped unique violation, should carry no bound parameter, query text or key detail', () => {
    const serialized = JSON.stringify(redactDbError(drizzleInsertFailure()));

    expect(serialized).not.toContain(SECRET_HASH);
    expect(serialized).not.toContain(CLAIM_HASH);
    expect(serialized).not.toContain('Failed query');
    expect(serialized).not.toContain('already exists');
  });

  it('given a bare pg error (no wrapper), should report its own code and constraint', () => {
    expect(redactDbError(pgUniqueViolation())).toEqual({
      errorName: 'Error',
      code: '23505',
      constraint: 'agent_identities_secretHash_unique',
    });
  });

  it('given a connection error code, should report it', () => {
    const error = new DrizzleQueryError('select 1', [], Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    expect(redactDbError(error).code).toBe('ECONNREFUSED');
  });

  it('given a code or constraint that is not an identifier (a value smuggled into the field), should drop it', () => {
    const cause = Object.assign(new Error('x'), { code: SECRET_HASH.slice(0, 40) + ' x', constraint: `(${SECRET_HASH})` });
    const redacted = redactDbError(new DrizzleQueryError('q', [SECRET_HASH], cause));

    expect(redacted.code).toBeNull();
    expect(redacted.constraint).toBeNull();
    expect(JSON.stringify(redacted)).not.toContain(SECRET_HASH);
  });

  it('given a non-error value, should report an unknown error with no fields', () => {
    expect(redactDbError(`params: ${SECRET_HASH}`)).toEqual({ errorName: 'unknown', code: null, constraint: null });
    expect(redactDbError(undefined)).toEqual({ errorName: 'unknown', code: null, constraint: null });
  });

  it('given a self-referencing cause chain, should terminate', () => {
    const error = new Error('loop') as Error & { cause?: unknown };
    error.cause = error;

    expect(redactDbError(error)).toEqual({ errorName: 'Error', code: null, constraint: null });
  });
});

describe('isDatabaseError', () => {
  it('given a drizzle query error, should be true', () => {
    expect(isDatabaseError(drizzleInsertFailure())).toBe(true);
  });

  it('given a bare pg error with a SQLSTATE, or one wrapped in a cause, should be true', () => {
    expect(isDatabaseError(pgUniqueViolation())).toBe(true);
    expect(isDatabaseError(Object.assign(new Error('wrapped'), { cause: Object.assign(new Error('x'), { code: '57014' }) }))).toBe(true);
    expect(isDatabaseError(Object.assign(new Error('internal'), { code: 'XX000' }))).toBe(true);
  });

  // A genuine code bug must never be mistaken for an outage: every Node
  // builtin error carries a SCREAMING_SNAKE code, none of them a SQLSTATE.
  it('given a real Node builtin error carrying a code, should be false', () => {
    let builtin: unknown;
    try {
      createHash('sha3-256').update(undefined as unknown as string);
    } catch (error) {
      builtin = error;
    }
    expect((builtin as { code?: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    expect(isDatabaseError(builtin)).toBe(false);
  });

  it.each(['ECONNREFUSED', 'EPIPE', 'ABORT_ERR', 'ERR_INVALID_ARG_TYPE', 'UND_ERR_SOCKET', 'ETIMEDOUT'])('given a non-SQLSTATE code %s, should be false', (code) => {
    expect(isDatabaseError(Object.assign(new Error('x'), { code }))).toBe(false);
  });

  it('given a plain error or a non-error, should be false', () => {
    expect(isDatabaseError(new TypeError('boom'))).toBe(false);
    expect(isDatabaseError('57014')).toBe(false);
    expect(isDatabaseError(undefined)).toBe(false);
  });
});
