import { RRule, Frequency, Weekday } from 'rrule';
import type { CalendarEvent, RecurrenceRule } from '../calendar';

/**
 * Expands a recurring event into individual event instances within a date range
 * @param event - The calendar event with recurrence rule
 * @param rangeStart - Start of the date range (ISO string)
 * @param rangeEnd - End of the date range (ISO string)
 * @returns Array of expanded event instances
 */
export function expandRecurringEvent(
  event: CalendarEvent,
  rangeStart: string,
  rangeEnd: string
): CalendarEvent[] {
  if (!event.recurrence) {
    // Not a recurring event, return as-is
    return [event];
  }

  try {
    // Parse the event start date
    const dtstart = new Date(event.start);
    const eventDuration = new Date(event.end).getTime() - dtstart.getTime();

    // Convert our RecurrenceRule to RRule options
    const rruleOptions = convertToRRuleOptions(event.recurrence, dtstart);

    // Create the RRule instance
    const rrule = new RRule(rruleOptions);

    // Get occurrences within the range
    const occurrences = rrule.between(
      new Date(rangeStart),
      new Date(rangeEnd),
      true // inclusive
    );

    // Create event instances for each occurrence
    return occurrences.map((occurrence, index) => {
      const instanceStart = occurrence.toISOString();
      const instanceEnd = new Date(occurrence.getTime() + eventDuration).toISOString();

      return {
        ...event,
        id: `${event.id}_${index}`, // Unique ID for each instance
        start: instanceStart,
        end: instanceEnd,
        // Note: We keep the recurrence rule so we know it's a recurring event instance
      };
    });
  } catch (error) {
    // If recurrence parsing fails, return the original event
    console.error('Error expanding recurring event:', error);
    return [event];
  }
}

/**
 * Converts our RecurrenceRule format to rrule library options
 */
function convertToRRuleOptions(recurrence: RecurrenceRule, dtstart: Date): Partial<RRule> {
  const options: any = {
    dtstart,
    interval: recurrence.interval || 1,
  };

  // Map frequency
  switch (recurrence.freq) {
    case 'DAILY':
      options.freq = RRule.DAILY;
      break;
    case 'WEEKLY':
      options.freq = RRule.WEEKLY;
      break;
    case 'MONTHLY':
      options.freq = RRule.MONTHLY;
      break;
    case 'YEARLY':
      options.freq = RRule.YEARLY;
      break;
    default:
      options.freq = RRule.DAILY;
  }

  // Add end condition (until or count)
  if (recurrence.until) {
    options.until = new Date(recurrence.until);
  } else if (recurrence.count !== undefined) {
    options.count = recurrence.count;
  }

  // Add by_weekday (e.g., ['MO', 'WE', 'FR'])
  if (recurrence.by_weekday && recurrence.by_weekday.length > 0) {
    options.byweekday = recurrence.by_weekday.map(day => convertWeekday(day));
  }

  // Add by_monthday (e.g., [1, 15])
  if (recurrence.by_monthday && recurrence.by_monthday.length > 0) {
    options.bymonthday = recurrence.by_monthday;
  }

  return options;
}

/**
 * Converts weekday string (e.g., 'MO') to RRule Weekday
 */
function convertWeekday(day: string): Weekday {
  const weekdayMap: Record<string, Weekday> = {
    'SU': RRule.SU,
    'MO': RRule.MO,
    'TU': RRule.TU,
    'WE': RRule.WE,
    'TH': RRule.TH,
    'FR': RRule.FR,
    'SA': RRule.SA,
  };

  return weekdayMap[day.toUpperCase()] || RRule.MO;
}

/**
 * Validates a recurrence rule
 * @param recurrence - The recurrence rule to validate
 * @returns Object with valid flag and optional error message
 */
export function validateRecurrenceRule(recurrence: RecurrenceRule): { valid: boolean; error?: string } {
  // Check frequency is valid
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(recurrence.freq)) {
    return { valid: false, error: 'Invalid frequency. Must be DAILY, WEEKLY, MONTHLY, or YEARLY' };
  }

  // Check interval is positive
  if (recurrence.interval < 1) {
    return { valid: false, error: 'Interval must be at least 1' };
  }

  // Check that either until or count is provided, not both
  if (recurrence.until && recurrence.count !== undefined) {
    return { valid: false, error: 'Cannot specify both until and count' };
  }

  // Check that at least one end condition is provided (until or count)
  if (!recurrence.until && recurrence.count === undefined) {
    return { valid: false, error: 'Must specify either until date or count' };
  }

  // Validate weekdays if provided
  if (recurrence.by_weekday) {
    const validWeekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    for (const day of recurrence.by_weekday) {
      if (!validWeekdays.includes(day.toUpperCase())) {
        return { valid: false, error: `Invalid weekday: ${day}` };
      }
    }
  }

  // Validate monthdays if provided
  if (recurrence.by_monthday) {
    for (const day of recurrence.by_monthday) {
      if (day < 1 || day > 31) {
        return { valid: false, error: `Invalid monthday: ${day}. Must be between 1 and 31` };
      }
    }
  }

  return { valid: true };
}

/**
 * Creates a human-readable description of a recurrence rule
 * @param recurrence - The recurrence rule
 * @returns Human-readable description
 */
export function describeRecurrenceRule(recurrence: RecurrenceRule): string {
  const parts: string[] = [];

  // Frequency and interval
  if (recurrence.interval === 1) {
    parts.push(recurrence.freq.toLowerCase());
  } else {
    parts.push(`every ${recurrence.interval} ${recurrence.freq.toLowerCase().replace('ly', 's')}`);
  }

  // Weekdays (for weekly recurrence)
  if (recurrence.by_weekday && recurrence.by_weekday.length > 0) {
    const weekdayNames: Record<string, string> = {
      'SU': 'Sunday',
      'MO': 'Monday',
      'TU': 'Tuesday',
      'WE': 'Wednesday',
      'TH': 'Thursday',
      'FR': 'Friday',
      'SA': 'Saturday',
    };
    const days = recurrence.by_weekday.map(d => weekdayNames[d.toUpperCase()]).join(', ');
    parts.push(`on ${days}`);
  }

  // Monthdays (for monthly recurrence)
  if (recurrence.by_monthday && recurrence.by_monthday.length > 0) {
    const days = recurrence.by_monthday.join(', ');
    parts.push(`on day ${days}`);
  }

  // End condition
  if (recurrence.until) {
    const untilDate = new Date(recurrence.until).toLocaleDateString();
    parts.push(`until ${untilDate}`);
  } else if (recurrence.count !== undefined) {
    parts.push(`for ${recurrence.count} times`);
  }

  return parts.join(' ');
}

/**
 * Helper to create a simple recurrence rule
 */
export function createRecurrenceRule(
  freq: RecurrenceRule['freq'],
  interval: number = 1,
  options: {
    until?: string;
    count?: number;
    byWeekday?: string[];
    byMonthday?: number[];
  } = {}
): RecurrenceRule {
  const rule: RecurrenceRule = {
    freq,
    interval,
  };

  if (options.until) {
    rule.until = options.until;
  }

  if (options.count !== undefined) {
    rule.count = options.count;
  }

  if (options.byWeekday) {
    rule.by_weekday = options.byWeekday;
  }

  if (options.byMonthday) {
    rule.by_monthday = options.byMonthday;
  }

  return rule;
}
