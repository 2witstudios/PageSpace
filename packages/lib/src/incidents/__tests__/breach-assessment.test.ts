import { describe, it, expect } from 'vitest';
import {
  AUTHORITY_NOTIFICATION_WINDOW_MS,
  computeAuthorityNotificationDeadline,
  assessNotifiability,
  assessIncident,
  isValidIncidentTransition,
  isAuthorityNotificationOverdue,
} from '../breach-assessment';

describe('computeAuthorityNotificationDeadline (Art 33 — 72h)', () => {
  it('returns detectedAt + 72 hours', () => {
    const detectedAt = new Date('2026-06-01T00:00:00.000Z');
    const deadline = computeAuthorityNotificationDeadline(detectedAt);
    expect(deadline.toISOString()).toBe('2026-06-04T00:00:00.000Z');
    expect(deadline.getTime() - detectedAt.getTime()).toBe(AUTHORITY_NOTIFICATION_WINDOW_MS);
  });

  it('does not mutate the input date', () => {
    const detectedAt = new Date('2026-06-01T00:00:00.000Z');
    const before = detectedAt.getTime();
    computeAuthorityNotificationDeadline(detectedAt);
    expect(detectedAt.getTime()).toBe(before);
  });

  it('is referentially transparent', () => {
    const detectedAt = new Date('2026-06-01T12:34:56.000Z');
    expect(computeAuthorityNotificationDeadline(detectedAt).toISOString()).toBe(
      computeAuthorityNotificationDeadline(detectedAt).toISOString(),
    );
  });
});

describe('assessNotifiability (Art 33 / Art 34)', () => {
  it('requires no notification when no personal data is involved', () => {
    expect(assessNotifiability({ riskLevel: 'high', involvesPersonalData: false })).toEqual({
      requiresAuthorityNotification: false,
      requiresSubjectNotification: false,
    });
  });

  it('low residual risk: no authority and no subject notification (Art 33 exemption)', () => {
    expect(assessNotifiability({ riskLevel: 'low', involvesPersonalData: true })).toEqual({
      requiresAuthorityNotification: false,
      requiresSubjectNotification: false,
    });
  });

  it('medium risk: authority notification required, subject notification not', () => {
    expect(assessNotifiability({ riskLevel: 'medium', involvesPersonalData: true })).toEqual({
      requiresAuthorityNotification: true,
      requiresSubjectNotification: false,
    });
  });

  it('high risk: both authority and subject notification required (Art 34)', () => {
    expect(assessNotifiability({ riskLevel: 'high', involvesPersonalData: true })).toEqual({
      requiresAuthorityNotification: true,
      requiresSubjectNotification: true,
    });
  });

  it('is referentially transparent', () => {
    const input = { riskLevel: 'medium' as const, involvesPersonalData: true };
    expect(assessNotifiability(input)).toEqual(assessNotifiability(input));
  });
});

describe('assessIncident', () => {
  it('attaches a deadline only when authority notification is required', () => {
    const detectedAt = new Date('2026-06-01T00:00:00.000Z');
    const high = assessIncident({ detectedAt, riskLevel: 'high', involvesPersonalData: true });
    expect(high.authorityNotificationDeadline?.toISOString()).toBe('2026-06-04T00:00:00.000Z');
    expect(high.requiresSubjectNotification).toBe(true);

    const low = assessIncident({ detectedAt, riskLevel: 'low', involvesPersonalData: true });
    expect(low.authorityNotificationDeadline).toBeNull();
    expect(low.requiresAuthorityNotification).toBe(false);
  });
});

describe('isValidIncidentTransition (lifecycle)', () => {
  it('allows the forward path detected → triaged → notified → closed', () => {
    expect(isValidIncidentTransition('detected', 'triaged')).toBe(true);
    expect(isValidIncidentTransition('triaged', 'notified')).toBe(true);
    expect(isValidIncidentTransition('notified', 'closed')).toBe(true);
  });

  it('allows early closure from detected or triaged', () => {
    expect(isValidIncidentTransition('detected', 'closed')).toBe(true);
    expect(isValidIncidentTransition('triaged', 'closed')).toBe(true);
  });

  it('rejects skipping states and backwards transitions', () => {
    expect(isValidIncidentTransition('detected', 'notified')).toBe(false);
    expect(isValidIncidentTransition('notified', 'detected')).toBe(false);
    expect(isValidIncidentTransition('closed', 'triaged')).toBe(false);
    expect(isValidIncidentTransition('triaged', 'triaged')).toBe(false);
  });
});

describe('isAuthorityNotificationOverdue', () => {
  it('is overdue once now passes the deadline', () => {
    const deadline = new Date('2026-06-04T00:00:00.000Z');
    expect(isAuthorityNotificationOverdue(deadline, new Date('2026-06-04T00:00:01.000Z'))).toBe(true);
    expect(isAuthorityNotificationOverdue(deadline, new Date('2026-06-03T23:59:59.000Z'))).toBe(false);
  });
});
