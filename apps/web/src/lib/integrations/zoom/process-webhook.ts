import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { zoomConnections, type ZoomConnection } from '@pagespace/db/schema/zoom';
import { CREDIT_HOLD_ESTIMATE_CENTS } from '@pagespace/lib/billing/credit-pricing';
import type { GateReason } from '@pagespace/lib/billing/credit-core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { pageService } from '@/services/api';
import { acquireUserCreditHold } from '@/lib/ai/core/user-credit-hold';
import { automationRunUnreserved, automationSpend } from '@pagespace/lib/billing/spend-target';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { getRecordings, downloadTranscript } from './zoom-api-client';
import { getValidZoomAccessToken } from './token-refresh';
import { parseVtt, vttToHtml } from './parse-vtt';
import { buildDocumentHtml } from './build-document';
import { generateTranscriptSummary } from './generate-summary';
import { extractActionItems } from './extract-action-items';

interface ZoomTranscriptPayload {
  event: string;
  payload: {
    account_id: string;
    object: {
      uuid: string;
      host_id: string;
      host_email: string;
      topic: string;
      start_time: string;
      duration: number;
    };
  };
}

export async function processZoomWebhook(
  body: unknown,
  preResolvedConnection?: ZoomConnection,
): Promise<void> {
  const event = body as ZoomTranscriptPayload;

  if (event?.event !== 'recording.transcript_completed') return;

  if (!event.payload?.account_id || !event.payload?.object) {
    loggers.api.warn('Zoom webhook: malformed recording.transcript_completed payload');
    return;
  }

  const { account_id } = event.payload;
  const { uuid: meetingUuid, host_id, host_email, topic, start_time, duration } = event.payload.object;

  // The webhook route resolves the connection once and shares it with both
  // handlers; fall back to a self-contained lookup for direct callers/tests.
  // Match the specific host user — host_id is the Zoom user ID of who ran the
  // meeting. Using both host_id and account_id prevents cross-account collision.
  const connection = preResolvedConnection ?? await db.query.zoomConnections.findFirst({
    where: and(
      eq(zoomConnections.zoomUserId, host_id),
      eq(zoomConnections.zoomAccountId, account_id),
    ),
  });

  if (!connection) {
    loggers.api.warn('Zoom webhook: no connection found for host', { host_id, account_id });
    return;
  }

  if (!connection.targetDriveId) {
    loggers.api.warn('Zoom webhook: connection has no target drive configured', {
      userId: connection.userId,
    });
    return;
  }

  if (connection.status !== 'active') {
    loggers.api.warn('Zoom webhook: connection is not active', {
      userId: connection.userId,
      status: connection.status,
    });
    return;
  }

  const tokenResult = await getValidZoomAccessToken(connection.userId);
  if (!tokenResult.success) {
    loggers.api.warn('Zoom webhook: could not obtain valid access token', {
      userId: connection.userId,
      error: tokenResult.error,
      requiresReauth: tokenResult.requiresReauth,
    });
    return;
  }
  const { accessToken } = tokenResult;

  // Re-fetch recording details from Zoom API using the meeting UUID from the verified event.
  // We never use download_url directly from the webhook payload — zero-trust.
  const recordingsResult = await getRecordings(accessToken, meetingUuid);
  if (!recordingsResult.success) {
    loggers.api.error('Zoom webhook: failed to fetch recordings from API', {
      error: recordingsResult.error,
      requiresReauth: recordingsResult.requiresReauth,
      userId: connection.userId,
    });
    return;
  }

  const transcriptFile = recordingsResult.data.recording_files.find((f) => f.file_type === 'TRANSCRIPT');
  if (!transcriptFile) {
    loggers.api.warn('Zoom webhook: no TRANSCRIPT file in recordings response', { topic });
    return;
  }

  // Download VTT using Bearer auth — token never appears in URL
  const downloadResult = await downloadTranscript(accessToken, transcriptFile.download_url);
  if (!downloadResult.success) {
    loggers.api.error('Zoom webhook: failed to download transcript', {
      error: downloadResult.error,
      userId: connection.userId,
    });
    return;
  }

  const vttText = downloadResult.data;

  // Parse VTT and extract plain text for AI calls
  const segments = parseVtt(vttText);
  const transcriptHtml = connection.includeTranscript ? vttToHtml(segments) : '';
  const plainText = segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');

  // AI enrichment (fail-safe — never blocks page creation). It passes the credit
  // gate first; a refusal still creates the page, just without the summary/action
  // items, and records why. A webhook trigger has no person present, so it spends
  // the target drive's wallet or is skipped, never the connection owner's credits
  // (SPEND-6), as the Zoom trigger executor does.
  const enrichment = await enrichTranscript(connection, connection.targetDriveId, plainText);
  const { summary, actionItems } = enrichment;

  const html = buildDocumentHtml(
    { topic, startTime: start_time, duration, hostEmail: host_email },
    { summary, actionItems, transcriptHtml }
  );

  // Title: YYYY-MM-DD — Topic
  const datePrefix = new Date(start_time).toISOString().slice(0, 10);
  const title = `${datePrefix} — ${topic}`;

  const result = await pageService.createPage(
    connection.userId,
    {
      title,
      type: 'DOCUMENT',
      driveId: connection.targetDriveId,
      parentId: connection.targetFolderId ?? null,
      content: html,
      contentMode: 'html',
    },
    {
      context: {
        metadata: {
          source: 'zoom_transcript',
          meetingUuid,
          ...(enrichment.skippedReason ? { aiEnrichmentSkipped: enrichment.skippedReason } : {}),
        },
      },
    }
  );

  if (!result.success) {
    loggers.api.error('Zoom webhook: failed to create transcript page', {
      error: result.error,
      userId: connection.userId,
      topic,
    });
    return;
  }

  loggers.api.info('Zoom transcript page created', {
    userId: connection.userId,
    pageId: result.page.id,
    title,
    meetingUuid,
  });
}

interface TranscriptEnrichment {
  summary: string;
  actionItems: Awaited<ReturnType<typeof extractActionItems>>;
  /**
   * Set when the credit gate refused the enrichment calls, could not be checked, or
   * reserved no drive wallet for them (SPEND-6, fail closed).
   */
  skippedReason?: GateReason | 'gate_error' | 'no_drive_wallet';
}

/**
 * Run the enabled AI enrichment calls behind ONE credit hold, sized for how many
 * model calls will run. skipDailyCap: server-triggered by Zoom, not interactive
 * fan-out — the same bound the Zoom/calendar trigger executors use. Each helper
 * debits its own real usage on the wallet the hold reserved, so the hold is
 * released exactly once when they settle, whether they succeeded or not.
 *
 * SPEND-6: the enrichment is a trigger, so it names the target drive as consumer
 * (automationSpend) and never falls back to the connection owner's wallet: with no
 * drive wallet reserved while wallets are live, it is skipped before any model call.
 */
async function enrichTranscript(
  connection: ZoomConnection,
  targetDriveId: string,
  plainText: string,
): Promise<TranscriptEnrichment> {
  const aiCalls = Number(connection.includeAiSummary) + Number(connection.includeActionItems);
  if (aiCalls === 0) return { summary: '', actionItems: [] };

  // A gate that cannot be checked (DB outage, lock timeout) must not block the
  // page either: skip the enrichment — no model call, no charge — and say why.
  const spend = automationSpend(targetDriveId);
  let hold: Awaited<ReturnType<typeof acquireUserCreditHold>>;
  try {
    hold = await acquireUserCreditHold(connection.userId, {
      spend,
      estCostCents: CREDIT_HOLD_ESTIMATE_CENTS * aiCalls,
      skipDailyCap: true,
    });
  } catch (err) {
    loggers.api.warn('Zoom webhook: AI enrichment skipped (credit gate failed)', {
      userId: connection.userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { summary: '', actionItems: [], skippedReason: 'gate_error' };
  }
  if (!hold.allowed) {
    loggers.api.info('Zoom webhook: AI enrichment skipped (credit gate denied)', {
      userId: connection.userId,
      reason: hold.reason,
    });
    return { summary: '', actionItems: [], skippedReason: hold.reason };
  }

  try {
    if (automationRunUnreserved({
      orgsEnabled: ORGS_ENABLED,
      billingEnabled: isBillingEnabled(),
      target: spend,
      walletId: hold.walletId,
    })) {
      loggers.api.warn('Zoom webhook: AI enrichment skipped (no drive wallet reserved)', {
        userId: connection.userId,
        driveId: targetDriveId,
      });
      return { summary: '', actionItems: [], skippedReason: 'no_drive_wallet' };
    }
    const [summary, actionItems] = await Promise.all([
      connection.includeAiSummary ? generateTranscriptSummary(connection.userId, plainText, hold.walletId) : Promise.resolve(''),
      connection.includeActionItems ? extractActionItems(connection.userId, plainText, hold.walletId) : Promise.resolve([]),
    ]);
    return { summary, actionItems };
  } finally {
    hold.release();
  }
}
