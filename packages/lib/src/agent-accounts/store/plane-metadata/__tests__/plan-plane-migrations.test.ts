/**
 * Slice 1 (deploy) — which plane metadata migrations to apply. The plane DB
 * has no Drizzle schema (its DDL is raw SQL with one owner), so the runner
 * records each applied file's name and checksum and this pure decision says
 * what is pending. It refuses rather than guesses: a recorded file that is
 * missing or changed, or a recorded history that is not a prefix of the
 * files on disk, means the DB and the code disagree about the schema.
 */
import { describe, expect, it } from 'vitest';
import { planPlaneMigrations, type PlaneMigrationFile } from '../plan-plane-migrations';

const file = (name: string, checksum = `sum-${name}`): PlaneMigrationFile => ({ name, checksum });
const available = [file('0001_init.sql'), file('0002_usage_index.sql'), file('0003_consent_expiry.sql')];

describe('planPlaneMigrations', () => {
  it('given a fresh DB, should apply every file in order', () => {
    const actual = planPlaneMigrations({ available, applied: [] });
    const expected = { ok: true, pending: ['0001_init.sql', '0002_usage_index.sql', '0003_consent_expiry.sql'] };
    expect(actual).toEqual(expected);
  });

  it('given a DB that applied a prefix, should apply only the rest', () => {
    const actual = planPlaneMigrations({ available, applied: [file('0001_init.sql')] });
    const expected = { ok: true, pending: ['0002_usage_index.sql', '0003_consent_expiry.sql'] };
    expect(actual).toEqual(expected);
  });

  it('given a DB that applied everything, should apply nothing', () => {
    const actual = planPlaneMigrations({ available, applied: available });
    const expected = { ok: true, pending: [] };
    expect(actual).toEqual(expected);
  });

  it('given files listed out of order, should still plan them in name order', () => {
    const actual = planPlaneMigrations({ available: [...available].reverse(), applied: [] });
    const expected = { ok: true, pending: ['0001_init.sql', '0002_usage_index.sql', '0003_consent_expiry.sql'] };
    expect(actual).toEqual(expected);
  });

  it('given an applied file whose checksum changed, should refuse naming it', () => {
    const actual = planPlaneMigrations({ available, applied: [file('0001_init.sql', 'edited')] });
    const expected = { ok: false, reason: 'checksum_mismatch', name: '0001_init.sql' };
    expect(actual).toEqual(expected);
  });

  it('given an applied file no longer on disk, should refuse naming it', () => {
    const actual = planPlaneMigrations({ available: [file('0001_init.sql')], applied: [file('0001_init.sql'), file('0002_usage_index.sql')] });
    const expected = { ok: false, reason: 'applied_unknown', name: '0002_usage_index.sql' };
    expect(actual).toEqual(expected);
  });

  it('given a new file sorted before an applied one, should refuse (history is not a prefix)', () => {
    const actual = planPlaneMigrations({ available, applied: [file('0001_init.sql'), file('0003_consent_expiry.sql')] });
    const expected = { ok: false, reason: 'out_of_order', name: '0002_usage_index.sql' };
    expect(actual).toEqual(expected);
  });

  it('given a file name outside NNNN_name.sql, should refuse naming it', () => {
    const actual = planPlaneMigrations({ available: [file('0001_init.sql'), file('fix.sql')], applied: [] });
    const expected = { ok: false, reason: 'bad_name', name: 'fix.sql' };
    expect(actual).toEqual(expected);
  });

  it('given two files with the same number, should refuse naming the second', () => {
    const actual = planPlaneMigrations({ available: [file('0001_init.sql'), file('0001_other.sql')], applied: [] });
    const expected = { ok: false, reason: 'duplicate_number', name: '0001_other.sql' };
    expect(actual).toEqual(expected);
  });

  it('given no files at all, should refuse (an empty folder is a packaging bug, not a no-op)', () => {
    const actual = planPlaneMigrations({ available: [], applied: [] });
    const expected = { ok: false, reason: 'no_migrations', name: null };
    expect(actual).toEqual(expected);
  });
});
