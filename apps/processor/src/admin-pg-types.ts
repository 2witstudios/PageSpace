/**
 * UTC type parsing for the Admin PG (trust plane) pools — #890 Phase 2 FIX.
 *
 * drizzle stores `timestamp` (WITHOUT time zone) columns as UTC wall clock
 * (write: toISOString; read: appends Z) — but pg's default text parser for
 * OID 1114 interprets the wall clock in the process's LOCAL zone. Raw-pg
 * reads on the trust plane feed hash recomputation (SIEM delivery preflight,
 * chainer verify-on-append), so a processor running with TZ ≠ UTC would
 * recompute shifted hashes → false chain_tamper → delivery halt + tamper
 * pages. Parsing OID 1114 as UTC on the admin pools makes the read side
 * match the write side regardless of process TZ.
 */

// @ts-expect-error -- pg has no bundled types; runtime cast below handles type safety
import pg from 'pg';

const pgTypes = (
  pg as unknown as { types: { getTypeParser(oid: number, format?: string): unknown } }
).types;

/** OID of `timestamp without time zone`. */
export const TIMESTAMP_WITHOUT_TZ_OID = 1114;

// pg's text wire format for OID 1114: 'YYYY-MM-DD HH:MM:SS[.ffffff]'.
const PG_TIMESTAMP_TEXT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

/**
 * Parse a timestamp-without-tz wire string ('2026-07-10 03:04:05.678') as
 * UTC wall clock — the zone drizzle wrote it in. Parsed field-by-field:
 * space-separated date strings are implementation-defined for `new Date()`
 * (V8 accepts them, JavaScriptCore often does not), and hash recomputation
 * cannot tolerate an engine-dependent Invalid Date.
 */
export function parsePgTimestampAsUtc(value: string): Date {
  const m = PG_TIMESTAMP_TEXT.exec(value);
  if (!m) {
    // Non-timestamp wire text ('infinity', BC dates): defer to the engine
    // rather than guess — these never feed hash recomputation.
    return new Date(`${value}+0000`);
  }
  const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms),
  );
}

export interface PgTypesConfig {
  getTypeParser(oid: number, format?: string): unknown;
}

/**
 * Pool-scoped `types` config for Admin PG pools: OID 1114 text reads parse
 * as UTC, everything else (including binary reads) falls through to pg's
 * defaults. Pool-scoped on purpose — the main-DB pool keeps stock behavior
 * (its columns are not raw-pg hash inputs on this plane; the process-wide
 * TZ=UTC entrypoint pin is a Phase 6 task).
 */
export function buildAdminPgTypes(): PgTypesConfig {
  return {
    getTypeParser(oid: number, format?: string): unknown {
      if (oid === TIMESTAMP_WITHOUT_TZ_OID && format !== 'binary') {
        return parsePgTimestampAsUtc;
      }
      return pgTypes.getTypeParser(oid, format);
    },
  };
}
