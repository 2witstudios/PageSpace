import { describe, it, expect } from 'vitest';
import {
  detectAuthAnomaly,
  buildAuthAnomalyAuditEvent,
  BRUTE_FORCE_FAILURE_THRESHOLD,
  CREDENTIAL_STUFFING_TARGET_THRESHOLD,
} from '../auth-anomaly';

describe('detectAuthAnomaly (#977)', () => {
  it('reports no anomaly below thresholds', () => {
    expect(detectAuthAnomaly({ identifier: 'ip', failureCount: 3 })).toEqual({
      isAnomaly: false,
      anomalyType: 'none',
      riskScore: 0,
      flags: [],
    });
  });

  it('flags brute force at the failure threshold', () => {
    const result = detectAuthAnomaly({ identifier: 'ip', failureCount: BRUTE_FORCE_FAILURE_THRESHOLD });
    expect(result.anomalyType).toBe('brute_force');
    expect(result.isAnomaly).toBe(true);
    expect(result.flags).toEqual(['brute_force']);
  });

  it('flags credential stuffing when many distinct targets are hit', () => {
    const result = detectAuthAnomaly({
      identifier: 'ip',
      failureCount: 5,
      distinctTargets: CREDENTIAL_STUFFING_TARGET_THRESHOLD,
    });
    expect(result.anomalyType).toBe('credential_stuffing');
    expect(result.riskScore).toBe(0.9);
  });

  it('prioritises credential stuffing over brute force', () => {
    const result = detectAuthAnomaly({
      identifier: 'ip',
      failureCount: 100,
      distinctTargets: CREDENTIAL_STUFFING_TARGET_THRESHOLD,
    });
    expect(result.anomalyType).toBe('credential_stuffing');
  });

  it('treats absent distinctTargets as a single target', () => {
    expect(detectAuthAnomaly({ identifier: 'ip', failureCount: 9 }).isAnomaly).toBe(false);
  });

  it('is referentially transparent', () => {
    const signal = { identifier: 'ip', failureCount: 11 };
    expect(detectAuthAnomaly(signal)).toEqual(detectAuthAnomaly(signal));
  });
});

describe('buildAuthAnomalyAuditEvent (#977)', () => {
  it('returns null when there is no anomaly', () => {
    const result = detectAuthAnomaly({ identifier: 'ip', failureCount: 1 });
    expect(buildAuthAnomalyAuditEvent(result, { identifier: 'ip', failureCount: 1 })).toBeNull();
  });

  it('maps brute force to the dedicated event type', () => {
    const signal = { identifier: 'ip', failureCount: 12 };
    const event = buildAuthAnomalyAuditEvent(detectAuthAnomaly(signal), signal, {
      ipAddress: '1.2.3.4',
      endpoint: 'magic-link/verify',
    });
    expect(event?.eventType).toBe('security.brute.force.detected');
    expect(event?.ipAddress).toBe('1.2.3.4');
    expect(event?.details).toMatchObject({ anomalyType: 'brute_force', endpoint: 'magic-link/verify' });
  });

  it('maps credential stuffing to the generic anomaly event type', () => {
    const signal = { identifier: 'ip', failureCount: 6, distinctTargets: 8 };
    const event = buildAuthAnomalyAuditEvent(detectAuthAnomaly(signal), signal);
    expect(event?.eventType).toBe('security.anomaly.detected');
    expect(event?.anomalyFlags).toEqual(['credential_stuffing']);
  });
});
