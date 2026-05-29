import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { zoomConnections, type ZoomConnection } from '@pagespace/db/schema/zoom';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { pageService } from '@/services/api';
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

  // AI enrichment (fail-safe — never blocks page creation)
  const [summary, actionItems] = await Promise.all([
    connection.includeAiSummary ? generateTranscriptSummary(connection.userId, plainText) : Promise.resolve(''),
    connection.includeActionItems ? extractActionItems(connection.userId, plainText) : Promise.resolve([]),
  ]);

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
    { context: { metadata: { source: 'zoom_transcript', meetingUuid } } }
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
