import { describe, it, expect, vi, beforeEach } from 'vitest';

const { returningMock, valuesMock, insertMock, logEventMock, captured } = vi.hoisted(() => {
  const captured = {
    persisted: null as Record<string, unknown> | null,
    auditEvent: null as Record<string, unknown> | null,
  };
  const returningMock = vi.fn();
  const valuesMock = vi.fn((values: Record<string, unknown>) => {
    captured.persisted = values;
    return { returning: returningMock };
  });
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  const logEventMock = vi.fn(async (event: Record<string, unknown>) => {
    captured.auditEvent = event;
    return undefined;
  });
  return { returningMock, valuesMock, insertMock, logEventMock, captured };
});

vi.mock('@pagespace/db/db', () => ({ db: { insert: insertMock } }));
vi.mock('../../audit/security-audit', () => ({ securityAudit: { logEvent: logEventMock } }));

vi.mock('../../logging/logger-config', () => ({
  loggers: { security: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } },
}));

import {
  createIncident,
  setIncidentNotifier,
} from '../incident-service';

beforeEach(() => {
  insertMock.mockClear();
  valuesMock.mockClear();
  returningMock.mockReset();
  logEventMock.mockClear();
  captured.persisted = null;
  captured.auditEvent = null;
  setIncidentNotifier(null);
});

describe('createIncident', () => {
  it('persists the incident with the computed Art 33/34 obligations and deadline', async () => {
    returningMock.mockResolvedValue([{ id: 'inc_1' }]);
    const detectedAt = new Date('2026-06-01T00:00:00.000Z');

    await createIncident({
      title: 'Exposed export bucket',
      severity: 'high',
      riskLevel: 'high',
      involvesPersonalData: true,
      detectedAt,
      affectedUserCount: 1200,
    });

    const persisted = captured.persisted!;
    expect(persisted.requiresAuthorityNotification).toBe(true);
    expect(persisted.requiresSubjectNotification).toBe(true);
    expect((persisted.authorityNotificationDeadline as Date).toISOString()).toBe('2026-06-04T00:00:00.000Z');
    expect(persisted.status).toBe('detected');
  });

  it('records a low-risk incident without an authority deadline', async () => {
    returningMock.mockResolvedValue([{ id: 'inc_2' }]);

    await createIncident({
      title: 'Internal mislog, no PII at risk',
      severity: 'low',
      riskLevel: 'low',
      involvesPersonalData: true,
    });

    const persisted = captured.persisted!;
    expect(persisted.requiresAuthorityNotification).toBe(false);
    expect(persisted.authorityNotificationDeadline).toBeNull();
  });

  it('emits an immutable security.incident.created audit event', async () => {
    returningMock.mockResolvedValue([{ id: 'inc_3' }]);

    await createIncident({
      title: 'Breach',
      severity: 'critical',
      riskLevel: 'high',
      involvesPersonalData: true,
    });

    expect(logEventMock).toHaveBeenCalledTimes(1);
    const event = captured.auditEvent!;
    expect(event.eventType).toBe('security.incident.created');
    expect(event.resourceType).toBe('incident');
    expect(event.resourceId).toBe('inc_3');
  });

  it('dispatches the registered notifier with the incident and assessment', async () => {
    returningMock.mockResolvedValue([{ id: 'inc_4' }]);
    const notifier = vi.fn<(n: { assessment: { requiresSubjectNotification: boolean } }) => void>();
    setIncidentNotifier(notifier);

    await createIncident({
      title: 'Breach',
      severity: 'high',
      riskLevel: 'high',
      involvesPersonalData: true,
    });

    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0][0].assessment.requiresSubjectNotification).toBe(true);
  });

  it('still returns the incident when the audit write fails (best-effort audit)', async () => {
    returningMock.mockResolvedValue([{ id: 'inc_5' }]);
    logEventMock.mockRejectedValueOnce(new Error('db down'));

    const incident = await createIncident({
      title: 'Breach',
      severity: 'high',
      riskLevel: 'medium',
      involvesPersonalData: true,
    });

    expect(incident).toEqual({ id: 'inc_5' });
  });
});
