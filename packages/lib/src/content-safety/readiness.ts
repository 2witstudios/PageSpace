/**
 * Enforce readiness — pure: what still stands between this deployment and
 * `CONTENT_SCAN_MODE=enforce`. Shown on the admin content console. It decides
 * nothing: enforce stays an environment change made by a person.
 */

import type { ContentScanBackfillCounts, ContentScanBackfillPhase, ContentScanOutcome } from '@pagespace/db/schema/content-safety';
import type { ScanModeSetting } from './scan-mode';

export type ReadinessStatus = 'ok' | 'blocking' | 'manual' | 'info';

export interface ReadinessItem {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
}

/** What the web app reports about its own environment. Booleans only: never a value. */
export interface ScanEnvironmentFacts {
  onPrem: boolean;
  mode: ScanModeSetting;
  problems: string[];
  hiveKeySet: boolean;
  evidenceBucketSet: boolean;
  abuseEmailSet: boolean;
  publishBucketSet: boolean;
  allowUnclassifiedVideo: boolean;
}

export interface ReadinessFacts {
  /** Null when the web app could not be asked. */
  environment: ScanEnvironmentFacts | null;
  backfill: {
    phase: ContentScanBackfillPhase;
    pass: number;
    counts: ContentScanBackfillCounts;
    lastPassCounts: ContentScanBackfillCounts | null;
    lastCompletedAt: Date | null;
  } | null;
  shadow: { days: number; counts: Array<{ outcome: ContentScanOutcome | null; count: number }> };
  openFlaggedCases: number;
}

export interface ReadinessReport {
  /** No item is `blocking`. Manual items (counsel) are still for a person to confirm. */
  ready: boolean;
  mode: ScanModeSetting | null;
  items: ReadinessItem[];
}

export const DEFAULT_READINESS_DAYS = 14;

function envItem(id: string, label: string, set: boolean | undefined, missing: string): ReadinessItem {
  if (set === undefined) return { id, label, status: 'blocking', detail: 'Unknown: the web app could not be asked.' };
  return set ? { id, label, status: 'ok', detail: 'Set on the web app.' } : { id, label, status: 'blocking', detail: missing };
}

const count = (counts: ReadinessFacts['shadow']['counts'], outcome: ContentScanOutcome) =>
  counts.find((entry) => entry.outcome === outcome)?.count ?? 0;

export function assessEnforceReadiness(facts: ReadinessFacts): ReadinessReport {
  const env = facts.environment;
  if (env?.onPrem) {
    return {
      ready: false,
      mode: 'off',
      items: [{ id: 'onprem', label: 'Deployment mode', status: 'info', detail: 'On-prem: scanning is always off (no external vendor).' }],
    };
  }

  const items: ReadinessItem[] = [
    envItem('hive_key', 'HIVE_API_KEY', env?.hiveKeySet, 'Not set: under enforce nothing would be published or accepted as an avatar.'),
    envItem('evidence_bucket', 'EVIDENCE_BUCKET', env?.evidenceBucketSet, 'Not set: a hash-match takedown blocks the file but cannot preserve or delete it.'),
    envItem('abuse_email', 'ABUSE_EMAIL', env?.abuseEmailSet, 'Not set: alerts go to the fallback contact address.'),
  ];

  const backfill = facts.backfill;
  if (!backfill) {
    items.push({ id: 'backfill', label: 'Backfill of already-public content', status: 'blocking', detail: 'Not started.' });
  } else if (!backfill.lastCompletedAt) {
    items.push({
      id: 'backfill',
      label: 'Backfill of already-public content',
      status: 'blocking',
      detail: `Pass ${backfill.pass} in progress (${backfill.phase}): ${backfill.counts.listed} objects checked so far.`,
    });
  } else {
    const last = backfill.lastPassCounts;
    const errors = last?.errors ?? 0;
    // A pass whose objects errored (a revoked key answers 401 for every one) checked nothing: not ready.
    items.push({
      id: 'backfill',
      label: 'Backfill of already-public content',
      status: errors > 0 ? 'blocking' : 'ok',
      detail:
        `Last pass completed ${backfill.lastCompletedAt.toISOString()}${last ? `: ${last.listed} objects, ${last.scanned} sent to the scanner` : ''}.` +
        (errors > 0 ? ` ${errors} could not be checked; they are retried on the next pass, which must finish with none.` : ''),
    });
    if (last && last.ignored > 0) {
      items.push({
        id: 'backfill_ignored',
        label: 'Objects the backfill does not recognise',
        status: 'info',
        detail: `${last.ignored} keys under assets/ or avatars/ were not a shape the backfill checks, and were left alone.`,
      });
    }
  }
  if (env && !env.publishBucketSet) {
    items.push({ id: 'publish_bucket', label: 'PUBLISH_BUCKET', status: 'info', detail: 'Not set on the web app: there are no public assets to backfill, only avatars.' });
  }

  const shadow = facts.shadow.counts;
  const total = shadow.reduce((sum, entry) => sum + entry.count, 0);
  const summary =
    `Last ${facts.shadow.days} days: ${count(shadow, 'classifier_flag')} flagged, ${count(shadow, 'hash_match')} hash matches, ` +
    `${count(shadow, 'error')} errors, ${count(shadow, 'unsupported_type')} unscanned types, ${count(shadow, 'unverified')} unverified videos, ` +
    `${count(shadow, 'clean')} clean. Every non-clean one would be held under enforce.`;
  items.push({
    id: 'shadow_results',
    label: 'Shadow-mode results',
    status: env?.mode === 'enforce' ? 'info' : total > 0 ? 'info' : 'blocking',
    detail: total > 0 ? summary : `No shadow-mode verdicts in the last ${facts.shadow.days} days: run shadow mode first.`,
  });

  items.push({
    id: 'flagged_reviewed',
    label: 'Flagged scans reviewed',
    status: facts.openFlaggedCases > 0 ? 'blocking' : 'ok',
    detail: facts.openFlaggedCases > 0 ? `${facts.openFlaggedCases} flagged case(s) still in the review queue.` : 'No flagged case is waiting for review.',
  });

  if (env && !env.allowUnclassifiedVideo) {
    items.push({
      id: 'video_classifier',
      label: 'Video classifier',
      status: 'info',
      detail: 'Video the classifier did not score is held under enforce. Set CONTENT_SCAN_ALLOW_UNCLASSIFIED_VIDEO=true once Hive confirms its classifier runs on video.',
    });
  }

  items.push(
    { id: 'processor_env', label: 'Processor environment', status: 'manual', detail: 'Avatar uploads are gated by the web app at the processor\'s request: the processor needs SERVICE_API_SECRET and WEB_APP_INTERNAL_URL, and CONTENT_SCAN_MODE set like the web app\'s (used only when the web app cannot be reached).' },
    { id: 'counsel', label: 'Counsel sign-off', status: 'manual', detail: 'Runbook, evidence retention, who may view flagged content, vendor scanning, legal holds and GDPR erasure.' },
  );

  return { ready: !items.some((item) => item.status === 'blocking'), mode: env?.mode ?? null, items };
}
