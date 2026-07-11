/**
 * UTC type-parsing on the Admin PG pools (#890 Phase 2 FIX).
 *
 * drizzle stores `timestamp` (WITHOUT time zone) columns as UTC wall clock
 * (mapToDriverValue = toISOString) and parses them back as UTC — but pg's
 * default text parser for OID 1114 interprets the wall clock in the
 * process's LOCAL zone. Every raw-pg read on the trust plane feeds hash
 * recomputation (SIEM preflight, chainer verify-on-append), so a processor
 * running with TZ ≠ UTC would recompute shifted hashes and halt delivery on
 * a false chain_tamper. The admin pools therefore override the OID 1114
 * parser to read the wall clock as UTC, matching the write side exactly.
 *
 * The TZ simulation mutates process.env.TZ for this file only (restored in
 * afterAll); assertions that REQUIRE an effective non-UTC zone are guarded
 * by tzShiftEffective so a runtime that ignores runtime TZ changes cannot
 * produce spurious failures — the parser's UTC contract is asserted
 * unconditionally either way.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const capturedPoolConfigs = vi.hoisted(
  () => [] as Array<{ connectionString: string; types?: { getTypeParser(oid: number, format?: string): unknown } }>,
);

vi.mock('pg', async (importOriginal) => {
  const actual = (await importOriginal()) as { default: Record<string, unknown> };
  class CapturingPool {
    constructor(config: (typeof capturedPoolConfigs)[number]) {
      capturedPoolConfigs.push(config);
    }
    connect() {
      return Promise.resolve({ query: vi.fn(), release: vi.fn() });
    }
    end() {
      return Promise.resolve();
    }
  }
  return { default: { ...actual.default, Pool: CapturingPool }, Pool: CapturingPool };
});

import {
  buildAdminPgTypes,
  parsePgTimestampAsUtc,
  TIMESTAMP_WITHOUT_TZ_OID,
} from '../admin-pg-types';
import { getAdminPoolForWorker } from '../db';
import { recomputeSecurityAuditHash } from '../services/siem-chain-hashers';

const ORIGINAL_TZ = process.env.TZ;

// The UTC instant the write side stored: drizzle serializes it as
// toISOString and pg's wire text for the column drops the T/Z.
const STORED_ISO = '2026-07-10T03:04:05.678Z';
const WIRE_TEXT = '2026-07-10 03:04:05.678';

let tzShiftEffective = false;

beforeAll(() => {
  process.env.TZ = 'Pacific/Auckland'; // UTC+12/+13 — never 0
  tzShiftEffective = new Date('2026-01-01 00:00:00').getTimezoneOffset() !== 0;
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

describe('parsePgTimestampAsUtc', () => {
  it('parses the wire wall clock as UTC regardless of process TZ', () => {
    expect(parsePgTimestampAsUtc(WIRE_TEXT).toISOString()).toBe(STORED_ISO);
    expect(parsePgTimestampAsUtc('2026-07-10 03:04:05').toISOString()).toBe(
      '2026-07-10T03:04:05.000Z',
    );
    // Microsecond precision (pg default for timestamp) truncates to ms.
    expect(parsePgTimestampAsUtc('2026-07-10 03:04:05.678901').toISOString()).toBe(STORED_ISO);
  });

  it("under a simulated non-UTC TZ, pg's default local parse WOULD shift the instant (the bug being fixed)", () => {
    if (!tzShiftEffective) return; // runtime ignores runtime TZ changes — contract assertions above still hold
    expect(new Date(WIRE_TEXT).toISOString()).not.toBe(STORED_ISO);
  });

  it('under a simulated non-UTC TZ, hash recomputation over a parser-read timestamp matches the write-side hash', () => {
    const fields = {
      eventType: 'auth.login.success',
      serviceId: 'web',
      resourceType: null,
      resourceId: null,
      details: { attempt: 1 },
      riskScore: null,
      anomalyFlags: null,
      timestamp: parsePgTimestampAsUtc(WIRE_TEXT),
    };
    const writeSide = recomputeSecurityAuditHash(
      { ...fields, timestamp: new Date(STORED_ISO) },
      'genesis',
    );
    expect(recomputeSecurityAuditHash(fields, 'genesis')).toBe(writeSide);
    if (tzShiftEffective) {
      // The default local parse recomputes a DIFFERENT hash — false tamper.
      expect(
        recomputeSecurityAuditHash({ ...fields, timestamp: new Date(WIRE_TEXT) }, 'genesis'),
      ).not.toBe(writeSide);
    }
  });
});

describe('buildAdminPgTypes', () => {
  it('returns the UTC parser for OID 1114 text reads and delegates everything else to pg defaults', () => {
    const types = buildAdminPgTypes();
    expect(types.getTypeParser(TIMESTAMP_WITHOUT_TZ_OID, 'text')).toBe(parsePgTimestampAsUtc);
    expect(types.getTypeParser(TIMESTAMP_WITHOUT_TZ_OID)).toBe(parsePgTimestampAsUtc);
    // Binary format is not ours to reinterpret.
    expect(types.getTypeParser(TIMESTAMP_WITHOUT_TZ_OID, 'binary')).not.toBe(
      parsePgTimestampAsUtc,
    );
    // int4 falls through to pg's own parser.
    const int4 = types.getTypeParser(23, 'text') as (v: string) => number;
    expect(int4('42')).toBe(42);
  });
});

describe('getAdminPoolForWorker', () => {
  it('constructs the admin pool with the UTC type parsers wired in', () => {
    process.env.ADMIN_DATABASE_URL = 'postgresql://admin_processor_user:pw@localhost:5432/scratch';
    getAdminPoolForWorker();
    const adminConfig = capturedPoolConfigs.find((c) =>
      c.connectionString.includes('admin_processor_user'),
    );
    expect(adminConfig).toBeDefined();
    const parser = adminConfig!.types?.getTypeParser(TIMESTAMP_WITHOUT_TZ_OID, 'text');
    expect(parser).toBe(parsePgTimestampAsUtc);
  });
});
