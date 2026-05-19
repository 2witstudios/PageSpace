import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { zoomConnections } from '@pagespace/db/schema/zoom';
import { decrypt } from '@pagespace/lib/encryption/encryption-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { pageService } from '@/services/api';
import { parseVtt, vttToHtml } from './parse-vtt';
import { buildDocumentHtml } from './build-document';
import { generateTranscriptSummary } from './generate-summary';
import { extractActionItems } from './extract-action-items';

interface RecordingFile {
  file_type: string;
  download_url: string;
}

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
      recording_files: RecordingFile[];
    };
  };
}

export async function processZoomWebhook(body: unknown): Promise<void> {
  const event = body as ZoomTranscriptPayload;

  if (event?.event !== 'recording.transcript_completed') return;

  if (!event.payload?.account_id || !event.payload?.object) {
    loggers.api.warn('Zoom webhook: malformed recording.transcript_completed payload');
    return;
  }

  const { account_id } = event.payload;
  const { uuid: meetingUuid, host_id, host_email, topic, start_time, duration, recording_files } = event.payload.object;

  // Match the specific host user — host_id is the Zoom user ID of who ran the meeting.
  // Using both host_id and account_id prevents cross-account collision.
  const connection = await db.query.zoomConnections.findFirst({
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

  // Find the VTT transcript file
  const transcriptFile = Array.isArray(recording_files)
    ? recording_files.find((f) => f.file_type === 'TRANSCRIPT')
    : undefined;
  if (!transcriptFile) {
    loggers.api.warn('Zoom webhook: no TRANSCRIPT file in recording_files', { topic });
    return;
  }

  // Fetch VTT content (Zoom recording downloads use access_token query param)
  let vttText: string;
  try {
    const parsedDownloadUrl = new URL(transcriptFile.download_url);
    const host = parsedDownloadUrl.hostname;
    if (host !== 'zoom.us' && !host.endsWith('.zoom.us')) {
      loggers.api.error('Zoom webhook: download_url host is not zoom.us', {
        host,
        userId: connection.userId,
      });
      return;
    }
    const accessToken = await decrypt(connection.accessToken);
    // Build a clean URL from validated parts only: validated host + path, discarding original query params.
    const safeUrl = new URL(`https://${host}${parsedDownloadUrl.pathname}`);
    safeUrl.searchParams.set('access_token', accessToken);
    const vttRes = await fetch(safeUrl, { signal: AbortSignal.timeout(30_000) }); // codeql[js/server-side-request-forgery] host is validated against the zoom.us allowlist above
    if (!vttRes.ok) {
      loggers.api.error('Zoom webhook: failed to download VTT', {
        status: vttRes.status,
        userId: connection.userId,
      });
      return;
    }
    vttText = await vttRes.text();
  } catch (err) {
    loggers.api.error('Zoom webhook: error fetching transcript', {
      error: err instanceof Error ? err.message : String(err),
      userId: connection.userId,
    });
    return;
  }

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
