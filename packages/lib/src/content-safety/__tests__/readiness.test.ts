import { describe, expect, it } from 'vitest';
import { emptyBackfillCounts } from '../backfill';
import { assessEnforceReadiness, type ReadinessFacts, type ScanEnvironmentFacts } from '../readiness';

const env: ScanEnvironmentFacts = {
  onPrem: false,
  mode: 'shadow',
  problems: [],
  hiveKeySet: true,
  evidenceBucketSet: true,
  abuseEmailSet: true,
  publishBucketSet: true,
  allowUnclassifiedVideo: false,
};

const ready: ReadinessFacts = {
  environment: env,
  backfill: { phase: 'done', pass: 1, counts: emptyBackfillCounts(), lastPassCounts: { ...emptyBackfillCounts(), listed: 10, scanned: 8 }, lastCompletedAt: new Date('2026-11-12T00:00:00Z') },
  shadow: { days: 14, counts: [{ outcome: 'clean', count: 40 }, { outcome: 'classifier_flag', count: 2 }] },
  openFlaggedCases: 0,
};

const status = (facts: ReadinessFacts, id: string) => assessEnforceReadiness(facts).items.find((item) => item.id === id)?.status;

describe('assessEnforceReadiness', () => {
  it('is ready when every check passes; counsel stays a manual item', () => {
    const report = assessEnforceReadiness(ready);
    expect(report.ready).toBe(true);
    expect(report.items.find((item) => item.id === 'counsel')?.status).toBe('manual');
    expect(report.items.find((item) => item.id === 'shadow_results')?.detail).toContain('2 flagged');
  });

  it.each([
    ['hive_key', { ...ready, environment: { ...env, hiveKeySet: false } }],
    ['evidence_bucket', { ...ready, environment: { ...env, evidenceBucketSet: false } }],
    ['abuse_email', { ...ready, environment: { ...env, abuseEmailSet: false } }],
    ['backfill', { ...ready, backfill: null }],
    ['backfill', { ...ready, backfill: { ...ready.backfill!, phase: 'avatars' as const, lastCompletedAt: null } }],
    ['shadow_results', { ...ready, shadow: { days: 14, counts: [] } }],
    ['flagged_reviewed', { ...ready, openFlaggedCases: 3 }],
  ])('%s blocks enforce', (id, facts) => {
    expect(status(facts, id)).toBe('blocking');
    expect(assessEnforceReadiness(facts).ready).toBe(false);
  });

  it('an unreachable web app blocks on every environment check', () => {
    const report = assessEnforceReadiness({ ...ready, environment: null });
    expect(report.items.filter((item) => item.status === 'blocking').map((item) => item.id)).toEqual(['hive_key', 'evidence_bucket', 'abuse_email']);
  });

  it('on-prem has nothing to enable', () => {
    expect(assessEnforceReadiness({ ...ready, environment: { ...env, onPrem: true } })).toMatchObject({ ready: false, mode: 'off', items: [{ id: 'onprem' }] });
  });

  it('notes the video classifier until unclassified video is accepted', () => {
    expect(status(ready, 'video_classifier')).toBe('info');
    expect(status({ ...ready, environment: { ...env, allowUnclassifiedVideo: true } }, 'video_classifier')).toBeUndefined();
  });
});
