import { describe, it, expect } from 'vitest';
import {
  SLA_DAYS,
  computeSlaDeadline,
  computeSlaStatus,
  summarizeSlaCompliance,
  type SlaTrackable,
} from '../sla';

const at = (iso: string) => new Date(iso);

describe('computeSlaDeadline', () => {
  it('given a receipt date, should add the default 30-day statutory window', () => {
    const deadline = computeSlaDeadline(at('2026-01-01T00:00:00.000Z'));
    expect(deadline.toISOString()).toBe(at('2026-01-31T00:00:00.000Z').toISOString());
  });

  it('given an explicit slaDays, should honour it instead of the default', () => {
    const deadline = computeSlaDeadline(at('2026-01-01T00:00:00.000Z'), 7);
    expect(deadline.toISOString()).toBe(at('2026-01-08T00:00:00.000Z').toISOString());
  });

  it('given the default constant, should be 30 days', () => {
    expect(SLA_DAYS).toBe(30);
  });

  it('should not mutate the injected receipt date', () => {
    const received = at('2026-01-01T00:00:00.000Z');
    computeSlaDeadline(received);
    expect(received.toISOString()).toBe(at('2026-01-01T00:00:00.000Z').toISOString());
  });
});

describe('computeSlaStatus', () => {
  const deadline = at('2026-01-31T00:00:00.000Z');

  it('given a completed request inside the window, should be met', () => {
    const req: SlaTrackable = {
      status: 'completed',
      slaDeadline: deadline,
      completedAt: at('2026-01-10T00:00:00.000Z'),
    };
    expect(computeSlaStatus(req, at('2026-02-15T00:00:00.000Z'))).toBe('met');
  });

  it('given a completed request after the deadline, should be breached', () => {
    const req: SlaTrackable = {
      status: 'completed',
      slaDeadline: deadline,
      completedAt: at('2026-02-05T00:00:00.000Z'),
    };
    expect(computeSlaStatus(req, at('2026-02-15T00:00:00.000Z'))).toBe('breached');
  });

  it('given an open request comfortably before the deadline, should be on_track', () => {
    const req: SlaTrackable = { status: 'in_progress', slaDeadline: deadline, completedAt: null };
    expect(computeSlaStatus(req, at('2026-01-05T00:00:00.000Z'))).toBe('on_track');
  });

  it('given an open request within 3 days of the deadline, should be due_soon', () => {
    const req: SlaTrackable = { status: 'in_progress', slaDeadline: deadline, completedAt: null };
    expect(computeSlaStatus(req, at('2026-01-29T00:00:00.000Z'))).toBe('due_soon');
  });

  it('given an open request past the deadline, should be overdue', () => {
    const req: SlaTrackable = { status: 'pending', slaDeadline: deadline, completedAt: null };
    expect(computeSlaStatus(req, at('2026-02-02T00:00:00.000Z'))).toBe('overdue');
  });

  it('given a cancelled request, should be not_applicable', () => {
    const req: SlaTrackable = { status: 'cancelled', slaDeadline: deadline, completedAt: null };
    expect(computeSlaStatus(req, at('2026-02-02T00:00:00.000Z'))).toBe('not_applicable');
  });
});

describe('summarizeSlaCompliance', () => {
  it('given a mixed list, should count each computed status bucket', () => {
    const deadline = at('2026-01-31T00:00:00.000Z');
    const now = at('2026-02-02T00:00:00.000Z');
    const requests: SlaTrackable[] = [
      { status: 'completed', slaDeadline: deadline, completedAt: at('2026-01-10T00:00:00.000Z') }, // met
      { status: 'completed', slaDeadline: deadline, completedAt: at('2026-02-05T00:00:00.000Z') }, // breached
      { status: 'pending', slaDeadline: deadline, completedAt: null }, // overdue
      { status: 'cancelled', slaDeadline: deadline, completedAt: null }, // not_applicable
    ];
    const summary = summarizeSlaCompliance(requests, now);
    expect(summary.total).toBe(4);
    expect(summary.met).toBe(1);
    expect(summary.breached).toBe(1);
    expect(summary.overdue).toBe(1);
    expect(summary.not_applicable).toBe(1);
  });
});
