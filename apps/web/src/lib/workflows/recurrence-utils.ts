type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RecurrenceRule {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byDay?: Weekday[];
  byMonthDay?: number[];
  byMonth?: number[];
  count?: number;
  until?: string;
}

const WEEKDAY_INDEX: Record<Weekday, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

const MS_PER_DAY = 86_400_000;

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

function withBaseTime(d: Date, base: Date): Date {
  return new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), 0,
  ));
}

/**
 * Expand a recurrence rule into concrete UTC timestamps within [from, to].
 *
 * Pure function — no I/O, no side effects. Safe to call in tests and in the
 * cron poller's refill step with identical inputs and expect identical output.
 *
 * Params:
 *   rule         — the recurrence rule (frequency, interval, byDay, etc.)
 *   baseStartAt  — the parent event's startAt; preserves time-of-day for all occurrences
 *   from         — lower bound (inclusive); occurrences before this are skipped
 *   to           — upper bound (inclusive); expansion stops here
 *   exceptions   — ISO date strings (YYYY-MM-DD or full ISO) to skip
 *
 * COUNT semantics: all occurrences from baseStartAt count toward rule.count,
 * including those before `from`. If the series is exhausted before `from`,
 * returns [].
 */
export function expandOccurrences(
  rule: RecurrenceRule,
  baseStartAt: Date,
  from: Date,
  to: Date,
  exceptions: string[],
): Date[] {
  // Parse UNTIL as end-of-day UTC so occurrences on the until date are included.
  // new Date("YYYY-MM-DD") parses as UTC midnight; without this adjustment any
  // event whose UTC time is after midnight on the until day would be excluded.
  const untilMs = (() => {
    if (!rule.until) return Infinity;
    const d = new Date(rule.until);
    d.setUTCHours(23, 59, 59, 999);
    return d.getTime();
  })();
  const effectiveTo = new Date(Math.min(untilMs, to.getTime()));

  const excluded = new Set(exceptions.map((e) => e.slice(0, 10)));
  const limit = rule.count ?? Infinity;
  const results: Date[] = [];
  let totalSeen = 0; // counts all occurrences from series start, including pre-from

  function collect(candidate: Date): boolean {
    if (candidate < baseStartAt) return true; // before series start — skip, don't count
    totalSeen++;
    if (totalSeen > limit) return false; // COUNT exhausted — stop
    if (candidate > effectiveTo) return false; // past window — stop
    if (candidate >= from && !excluded.has(candidate.toISOString().slice(0, 10))) {
      results.push(candidate);
    }
    return true; // continue
  }

  switch (rule.frequency) {
    case 'DAILY': {
      let cursor = new Date(baseStartAt);
      while (cursor <= effectiveTo) {
        if (!collect(cursor)) break;
        cursor = addDays(cursor, rule.interval);
      }
      break;
    }

    case 'WEEKLY': {
      const targetDays = (
        rule.byDay?.map((d) => WEEKDAY_INDEX[d]) ?? [baseStartAt.getUTCDay()]
      ).sort((a, b) => a - b);

      // Sunday UTC of the week containing baseStartAt
      const offsetToSunday = baseStartAt.getUTCDay();
      let weekSunday = utcMidnight(addDays(baseStartAt, -offsetToSunday));

      outer: while (weekSunday <= effectiveTo) {
        for (const wd of targetDays) {
          const candidate = withBaseTime(addDays(weekSunday, wd), baseStartAt);
          if (!collect(candidate)) break outer;
        }
        weekSunday = addDays(weekSunday, 7 * rule.interval);
      }
      break;
    }

    case 'MONTHLY': {
      const targetDays = rule.byMonthDay ?? [baseStartAt.getUTCDate()];
      let y = baseStartAt.getUTCFullYear();
      let m = baseStartAt.getUTCMonth();

      outer: while (true) {
        const maxDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        for (const targetDay of targetDays) {
          if (targetDay > maxDay) continue; // skip days that don't exist in this month
          const candidate = new Date(Date.UTC(
            y, m, targetDay,
            baseStartAt.getUTCHours(), baseStartAt.getUTCMinutes(), baseStartAt.getUTCSeconds(), 0,
          ));
          if (!collect(candidate)) break outer;
        }
        m += rule.interval;
        if (m >= 12) { y += Math.floor(m / 12); m %= 12; }
      }
      break;
    }

    case 'YEARLY': {
      let y = baseStartAt.getUTCFullYear();
      // byMonth uses 1-indexed month numbers; convert to 0-indexed for Date.UTC
      const months = rule.byMonth?.map((mo) => mo - 1) ?? [baseStartAt.getUTCMonth()];
      const days = rule.byMonthDay ?? [baseStartAt.getUTCDate()];

      outer: while (true) {
        for (const mo of months) {
          const maxDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
          for (const d of days) {
            if (d > maxDay) continue; // skip days that don't exist in this month
            const candidate = new Date(Date.UTC(
              y, mo, d,
              baseStartAt.getUTCHours(), baseStartAt.getUTCMinutes(), baseStartAt.getUTCSeconds(), 0,
            ));
            if (!collect(candidate)) break outer;
          }
        }
        y += rule.interval;
      }
      break;
    }
  }

  return results;
}
