import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
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
      topic: string;
      start_time: string;
      duration: number;
      host_email: string;
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
  const { topic, start_time, duration, host_email, recording_files } = event.payload.object;

  // Look up the PageSpace user by Zoom account ID
  const connection = await db.query.zoomConnections.findFirst({
    where: eq(zoomConnections.zoomAccountId, account_id),
  });

  if (!connection) {
    loggers.api.warn('Zoom webhook: no connection found for account', { account_id });
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
    const accessToken = await decrypt(connection.accessToken);
    const vttUrl = `${transcriptFile.download_url}?access_token=${encodeURIComponent(accessToken)}`;
    const vttRes = await fetch(vttUrl);
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
    { context: { metadata: { source: 'zoom_transcript' } } }
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
  });
}
