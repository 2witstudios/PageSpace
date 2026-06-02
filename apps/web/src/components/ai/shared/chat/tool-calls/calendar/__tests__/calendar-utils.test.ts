import { describe, it, expect } from 'vitest';
import {
  eventColorDot,
  rsvpColor,
  formatTime,
  formatDayLabel,
  dayKey,
  formatEventRange,
  calendarEventHref,
} from '../calendar-utils';

const TZ = 'UTC';

describe('calendar-utils', () => {
  describe('eventColorDot', () => {
    it('maps known color categories', () => {
      expect(eventColorDot('meeting')).toBe('bg-blue-500');
      expect(eventColorDot('deadline')).toBe('bg-red-500');
      expect(eventColorDot('PERSONAL')).toBe('bg-emerald-500'); // case-insensitive
    });
    it('falls back to the default dot for unknown/empty', () => {
      expect(eventColorDot(undefined)).toBe('bg-slate-400');
      expect(eventColorDot(null)).toBe('bg-slate-400');
      expect(eventColorDot('not-a-color')).toBe('bg-slate-400');
    });
  });

  describe('rsvpColor', () => {
    it('maps RSVP statuses (case-insensitive) to colors', () => {
      expect(rsvpColor('accepted')).toContain('green');
      expect(rsvpColor('DECLINED')).toContain('red');
      expect(rsvpColor('Tentative')).toContain('amber');
    });
    it('uses muted color for unknown/missing status', () => {
      expect(rsvpColor(undefined)).toBe('text-muted-foreground');
      expect(rsvpColor('PENDING')).toBe('text-muted-foreground');
    });
  });

  describe('formatTime / formatDayLabel', () => {
    it('formats a time and a day label in the given timezone', () => {
      const iso = '2026-06-02T14:30:00Z';
      expect(formatTime(iso, TZ)).toMatch(/2:30/);
      expect(formatTime(iso, TZ)).toMatch(/PM/);
      expect(formatDayLabel(iso, TZ)).toContain('Jun 2');
    });
    it('returns empty string for missing/invalid input', () => {
      expect(formatTime(undefined, TZ)).toBe('');
      expect(formatTime('not-a-date', TZ)).toBe('');
      expect(formatDayLabel(undefined, TZ)).toBe('');
    });
  });

  describe('dayKey', () => {
    it('is stable within a day and differs across days', () => {
      const a = dayKey('2026-06-02T01:00:00Z', TZ);
      const b = dayKey('2026-06-02T23:00:00Z', TZ);
      const c = dayKey('2026-06-03T01:00:00Z', TZ);
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });
    it('returns "unknown" for invalid input', () => {
      expect(dayKey(undefined, TZ)).toBe('unknown');
      expect(dayKey('nope', TZ)).toBe('unknown');
    });
  });

  describe('formatEventRange', () => {
    it('formats a timed same-day range', () => {
      const r = formatEventRange('2026-06-02T14:00:00Z', '2026-06-02T15:00:00Z', false, TZ);
      expect(r).toContain('Jun 2');
      expect(r).toContain('2:00');
      expect(r).toContain('3:00');
      expect(r).toContain('–');
    });
    it('formats an all-day single day', () => {
      const r = formatEventRange('2026-06-02T00:00:00Z', '2026-06-02T23:59:00Z', true, TZ);
      expect(r).toContain('Jun 2');
      expect(r).toContain('all day');
    });
    it('formats a cross-day all-day span', () => {
      const r = formatEventRange('2026-06-02T00:00:00Z', '2026-06-04T00:00:00Z', true, TZ);
      expect(r).toContain('Jun 2');
      expect(r).toContain('Jun 4');
      expect(r).toContain('all day');
    });
    it('returns empty string when start is missing/invalid', () => {
      expect(formatEventRange(undefined, undefined, false, TZ)).toBe('');
    });
  });

  describe('calendarEventHref', () => {
    it('links to a drive calendar with eventId and date', () => {
      const href = calendarEventHref({ id: 'e1', driveId: 'd1', startAt: '2026-06-02T14:00:00Z' });
      expect(href).not.toBeNull();
      expect(href!.startsWith('/dashboard/d1/calendar?')).toBe(true);
      expect(href).toContain('eventId=e1');
      expect(href).toContain('date=');
    });
    it('links to the personal calendar when there is no driveId', () => {
      const href = calendarEventHref({ id: 'e1', startAt: '2026-06-02T14:00:00Z' });
      expect(href!.startsWith('/dashboard/calendar?')).toBe(true);
      expect(href).toContain('eventId=e1');
    });
    it('omits the date param when startAt is absent', () => {
      const href = calendarEventHref({ id: 'e1', driveId: 'd1' });
      expect(href).toBe('/dashboard/d1/calendar?eventId=e1');
    });
    it('returns null when there is no event id', () => {
      expect(calendarEventHref({ driveId: 'd1' })).toBeNull();
    });
  });
});
