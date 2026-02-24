import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';

export function validateCronExpression(expression: string): { valid: boolean; error?: string } {
  try {
    CronExpressionParser.parse(expression);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Invalid cron expression' };
  }
}

export function getNextRunDate(expression: string, timezone: string, after?: Date): Date {
  const interval = CronExpressionParser.parse(expression, {
    tz: timezone,
    currentDate: after ?? new Date(),
  });
  return interval.next().toDate();
}

export function validateTimezone(timezone: string): { valid: boolean; error?: string } {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return { valid: true };
  } catch {
    return { valid: false, error: `Invalid timezone: ${timezone}` };
  }
}

export function getHumanReadableCron(expression: string): string {
  try {
    return cronstrue.toString(expression, { use24HourTimeFormat: false });
  } catch {
    return expression;
  }
}
