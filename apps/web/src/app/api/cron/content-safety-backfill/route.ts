import { NextResponse } from 'next/server';
import { audit } from '@pagespace/lib/audit/audit-log';
import {
  BACKFILL_PHASES,
  resolveBackfillConfig,
  runBackfillDryRun,
  runBackfillTick,
  type BackfillWalkPhase,
} from '@pagespace/lib/content-safety/backfill';
import { resolveScanConfigFromEnv } from '@pagespace/lib/content-safety/scan-mode';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { createBackfillDeps, createDryRunDeps } from '@/lib/content-safety/backfill-service';

/**
 * Cron endpoint: scan content that was already public before the publish gate
 * existed, and rescan it as verdicts expire.
 *
 * Each tick walks at most `CONTENT_SCAN_BACKFILL_ITEMS_PER_TICK` objects from
 * where the last one stopped: the publish bucket's `assets/`, then the uploads
 * bucket's `avatars/`. Anything with a fresh verdict is skipped without a read
 * or a vendor call. A finished pass starts again after
 * `CONTENT_SCAN_BACKFILL_REPASS_HOURS`. What each finding does is in
 * `lib/content-safety/backfill-service.ts`.
 *
 * A no-op on-prem (no external vendor), with scanning off, or with no vendor key
 * (a walk that recorded nothing must not mark existing content as checked).
 *
 * `?dryRun=1` counts objects and estimates vendor calls instead: no scan, no
 * byte read, no cursor change, in any mode but on-prem. It stops after
 * `maxPages` listing pages (default 50, of 1000 keys) and answers `next`;
 * pass `phase` and `startAfter` back to continue.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature.
 */

const DEFAULT_DRY_RUN_PAGES = 50;
const MAX_DRY_RUN_PAGES = 1000;

function dryRunFrom(url: URL): { phase: BackfillWalkPhase; startAfter: string | null } | undefined {
  const phase = url.searchParams.get('phase');
  if (!phase || !BACKFILL_PHASES.includes(phase as BackfillWalkPhase)) return undefined;
  return { phase: phase as BackfillWalkPhase, startAfter: url.searchParams.get('startAfter') || null };
}

export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) return authError;

  if (isOnPrem()) return NextResponse.json({ success: true, skipped: 'onprem' });

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1' || url.searchParams.get('dryRun') === 'true';
  const config = resolveScanConfigFromEnv();

  try {
    if (dryRun) {
      const pages = Math.min(Math.max(1, Number(url.searchParams.get('maxPages')) || DEFAULT_DRY_RUN_PAGES), MAX_DRY_RUN_PAGES);
      const result = await runBackfillDryRun(createDryRunDeps(), { verdictTtlMs: config.verdictTtlMs, maxPages: pages, from: dryRunFrom(url) });
      return NextResponse.json({ success: true, dryRun: true, mode: config.mode, ...result });
    }

    if (config.mode === 'off') return NextResponse.json({ success: true, skipped: 'scan_off' });
    if (!config.scannerConfigured) {
      loggers.system.warn('[Cron] Content-safety backfill skipped: HIVE_API_KEY is not set', { mode: config.mode });
      return NextResponse.json({ success: true, skipped: 'scanner_not_configured' });
    }

    const result = await runBackfillTick(createBackfillDeps(config), resolveBackfillConfig(process.env));
    const failed = result.state === 'walked' && result.failedKey !== undefined;

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'content_safety_backfill',
      details: {
        state: result.state,
        mode: config.mode,
        ...(result.state === 'walked'
          ? { pass: result.pass, phase: result.phase, processed: result.processed, scanned: result.scanned, completed: result.completed, failed }
          : {}),
      },
    });

    // The failed key is not returned or logged: an avatar key names a user, an asset key a content hash.
    const body =
      result.state === 'walked'
        ? { success: !failed, state: result.state, pass: result.pass, phase: result.phase, processed: result.processed, scanned: result.scanned, completed: result.completed }
        : result.state === 'idle'
          ? { success: true, state: result.state, pass: result.pass, nextPassAt: result.nextPassAt.toISOString() }
          : { success: true, state: result.state };
    return NextResponse.json(body, { status: failed ? 500 : 200 });
  } catch (error) {
    loggers.system.error('[Cron] Content-safety backfill failed', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: 'Backfill failed' }, { status: 500 });
  }
}
