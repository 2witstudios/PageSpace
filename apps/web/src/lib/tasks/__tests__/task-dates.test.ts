import { describe, it, expect } from 'vitest';
import { isStartAfterDue, parseTaskDateInput } from '../task-dates';

describe('isStartAfterDue', () => {
  const start = new Date('2026-10-25T09:00:00.000Z');

  it('given no start or no due date, should not refuse', () => {
    expect(isStartAfterDue(null, start)).toBe(false);
    expect(isStartAfterDue(start, undefined)).toBe(false);
  });

  it('given a due date at the very instant of the start, should accept it', () => {
    expect(isStartAfterDue(start, new Date(start.getTime()))).toBe(false);
  });

  it('given a due date later the same day, should accept it', () => {
    expect(isStartAfterDue(start, new Date('2026-10-25T17:00:00.000Z'))).toBe(false);
  });

  it('given a due date earlier than the start on the same day, should refuse it, comparing instants', () => {
    expect(isStartAfterDue(start, new Date('2026-10-25T00:00:00.000Z'))).toBe(true);
  });

  it('given a due date on an earlier day, should refuse it', () => {
    expect(isStartAfterDue(start, new Date('2026-10-24T23:00:00.000Z'))).toBe(true);
  });
});

describe('parseTaskDateInput', () => {
  it('given an empty value, should clear the date', () => {
    expect(parseTaskDateInput('', 'UTC')).toEqual({ ok: true, value: null });
    expect(parseTaskDateInput(null, 'UTC')).toEqual({ ok: true, value: null });
  });

  it('given a full ISO instant, should keep that instant', () => {
    expect(parseTaskDateInput('2026-10-25T09:00:00.000Z', 'America/New_York')).toEqual({
      ok: true,
      value: new Date('2026-10-25T09:00:00.000Z'),
    });
  });

  it('given a naive datetime, should read it in the given timezone', () => {
    expect(parseTaskDateInput('2026-10-25T09:00', 'UTC')).toEqual({
      ok: true,
      value: new Date('2026-10-25T09:00:00.000Z'),
    });
  });

  it('given something that is not a date, should reject it', () => {
    expect(parseTaskDateInput('soon', 'UTC')).toEqual({ ok: false });
    expect(parseTaskDateInput({ at: 1 }, 'UTC')).toEqual({ ok: false });
  });
});
