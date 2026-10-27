/**
 * Range-bound parsing for listing filters (#2404).
 *
 * Two separate claims are pinned here, because the routes got both wrong in
 * opposite directions: a bound must not be read in whatever timezone the server
 * happens to run in, and an `endDate` that names an instant must not be quietly
 * stretched by a day.
 *
 * TZ is pinned away from UTC for the whole file: under the old local-`setDate`
 * arithmetic these assertions pass on a UTC machine and fail elsewhere, which is
 * exactly the environment-dependence being removed.
 */
process.env.TZ = 'America/Chicago';

import { describe, it, expect } from 'vitest';
import { absoluteInstant, optionalAbsoluteInstant, exclusiveEndBound } from '../date-params';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('absoluteInstant', () => {
  it('reads a naive bound as UTC rather than server-local time', () => {
    assert({
      given: 'a naive datetime bound and a non-UTC server timezone',
      should: 'pin it to UTC so the window does not move with the deployment',
      actual: absoluteInstant.parse('2026-02-19T19:00:00'),
      expected: new Date('2026-02-19T19:00:00Z'),
    });
  });

  it('leaves a bound that states its own offset alone', () => {
    assert({
      given: 'a bound carrying +09:00',
      should: 'honour the stated offset',
      actual: absoluteInstant.parse('2026-02-19T19:00:00+09:00'),
      expected: new Date('2026-02-19T10:00:00Z'),
    });
  });

  it('reads a date-only bound as UTC midnight', () => {
    assert({
      given: 'a date with no time',
      should: 'keep the ISO 8601 meaning',
      actual: absoluteInstant.parse('2026-02-19'),
      expected: new Date('2026-02-19T00:00:00Z'),
    });
  });

  it('lets the optional variant pass undefined through', () => {
    assert({
      given: 'an omitted bound',
      should: 'stay undefined rather than becoming the epoch',
      actual: optionalAbsoluteInstant.parse(undefined),
      expected: undefined,
    });
  });
});

describe('exclusiveEndBound', () => {
  it('covers the whole day for a date-only bound', () => {
    assert({
      given: '"through the 19th"',
      should: 'end at the start of the 20th, so the 19th is included',
      actual: exclusiveEndBound('2026-02-19', new Date('2026-02-19T00:00:00Z')),
      expected: new Date('2026-02-20T00:00:00Z'),
    });
  });

  it('does not stretch a bound that names an instant', () => {
    assert({
      given: 'an explicit 19:00Z upper bound',
      should: 'end exactly there, not 24 hours later',
      actual: exclusiveEndBound('2026-02-19T19:00:00Z', new Date('2026-02-19T19:00:00Z')),
      expected: new Date('2026-02-19T19:00:00Z'),
    });
  });

  it('does not stretch a naive instant bound either', () => {
    assert({
      given: 'a naive datetime bound',
      should: 'stay the instant it parsed to',
      actual: exclusiveEndBound('2026-02-19T19:00:00', new Date('2026-02-19T19:00:00Z')),
      expected: new Date('2026-02-19T19:00:00Z'),
    });
  });

  /**
   * This is the case that actually discriminates UTC arithmetic from local
   * `setDate`. On an ordinary date the two agree for any whole-hour offset, so
   * a plain "adds a day" assertion would pass either way and prove nothing;
   * across a DST transition local arithmetic yields 23 or 25 hours instead of
   * 24. US DST starts 2026-03-08.
   */
  it('adds the day in UTC — a local +1 day across a DST boundary is not 24 hours', () => {
    assert({
      given: 'a date-only bound on the day a DST transition falls',
      should: 'advance exactly one UTC day regardless of the server timezone',
      actual: exclusiveEndBound('2026-03-08', new Date('2026-03-08T00:00:00Z')),
      expected: new Date('2026-03-09T00:00:00Z'),
    });
  });

  it('treats a padded date-only bound as a day', () => {
    assert({
      given: 'a date-only bound with stray whitespace',
      should: 'still get the inclusive-day treatment',
      actual: exclusiveEndBound(' 2026-02-19 ', new Date('2026-02-19T00:00:00Z')),
      expected: new Date('2026-02-20T00:00:00Z'),
    });
  });

  it('returns the parsed value when there is no raw string to inspect', () => {
    assert({
      given: 'no raw query value',
      should: 'fall back to the parsed instant untouched',
      actual: exclusiveEndBound(null, new Date('2026-02-19T19:00:00Z')),
      expected: new Date('2026-02-19T19:00:00Z'),
    });
  });
});
