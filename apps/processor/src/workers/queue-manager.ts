import PgBoss from 'pg-boss';
import type {
  ProcessingJob,
  QueueName,
  JobDataMap,
  QueueStats,
  IngestFileJobData,
  ImageOptimizeJobData,
  TextExtractJobData,
  OCRJobData,
  VideoProcessJobData,
  PullVerifyJobData,
  AccountErasureJobData,
  EmailBroadcastJobData,
  TextExtractResult,
  IngestResult,
} from '../types';
import { setPageCompleted, setPageFailed, setPageProcessing, setPageVideoProcessed, setPageVisual } from '../db';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { needsTextExtraction } from './text-extractor';

export function mapJobState(state: string): ProcessingJob['status'] {
  switch (state) {
    case 'created':
    case 'retry':
      return 'pending';
    case 'active':
      return 'processing';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'expired':
    case 'cancelled':
      return 'failed';
    default:
      return 'pending';
  }
}

const EMPTY_STATS: QueueStats = { active: 0, pending: 0, completed: 0, failed: 0 };

export class QueueManager {
  private boss: PgBoss | null = null;
  private connectionString: string;
  private cachedStates: PgBoss.MonitorStates | null = null;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required for QueueManager');
    }
    this.connectionString = connectionString;
  }

  async initialize(): Promise<void> {
    this.boss = new PgBoss({
      connectionString: this.connectionString,
      migrate: true,
      schema: 'pgboss',
      application_name: 'processor-service',
      max: 10, // Connection pool size
      retentionDays: 7,
      monitorStateIntervalSeconds: 30
    });

    await this.boss.start();

    this.boss.on('monitor-states', (states: PgBoss.MonitorStates) => {
      this.cachedStates = states;
    });

    // Define queue configurations
    await this.setupQueues();
    
    // Start queue workers
    await this.startWorkers();
  }

  private async setupQueues(): Promise<void> {
    if (!this.boss) throw new Error('Queue manager not initialized');

    try {
      await this.boss.createQueue('ingest-file');
      await this.boss.createQueue('pull-verify');
      await this.boss.createQueue('image-optimize');
      await this.boss.createQueue('text-extract');
      await this.boss.createQueue('ocr-process');
      await this.boss.createQueue('video-process');
      await this.boss.createQueue('siem-delivery');
      await this.boss.createQueue('account-erasure');
      await this.boss.createQueue('audit-chainer');
      await this.boss.createQueue('email-broadcast');
      await this.boss.createQueue('stuck-page-reconciler');
      console.log('PgBoss queues created/verified');
    } catch (err) {
      console.warn('Queue creation warning:', err instanceof Error ? err.message : err);
    }
  }

  private async startWorkers(): Promise<void> {
    if (!this.boss) throw new Error('Queue manager not initialized');

    // Import worker functions
    const { processImage } = await import('./image-processor');
    const { extractText } = await import('./text-extractor');
    const { processOCR } = await import('./ocr-processor');
    const { processVideo } = await import('./video-processor');
    const { runPullPipeline } = await import('../api/s3-pull-adapter');

    // Unified ingestion worker
    await this.boss.work('ingest-file',
      async ([job]) => {
        console.log(`Processing ingest-file job: ${job.id}`);
        const data = job.data as IngestFileJobData;
        const { contentHash, fileId, mimeType, originalName } = data;

        try {
          if (!fileId || !contentHash) {
            throw new Error('Invalid ingest-file job: missing fileId or contentHash');
          }

          // Set page status to processing
          await setPageProcessing(fileId);

          // Videos → mark visual and queue thumbnail/metadata extraction
          if (mimeType && mimeType.startsWith('video/')) {
            await setPageVisual(fileId);
            await this.addJob('video-process', { contentHash, fileId, mimeType });
            return { success: true, status: 'visual' } satisfies IngestResult;
          }

          // Images → mark visual and queue optimizations
          if (mimeType && mimeType.startsWith('image/')) {
            await setPageVisual(fileId);

            // Kick off optimizations asynchronously
            await this.addJob('image-optimize', { contentHash, preset: 'ai-chat', fileId });
            await this.addJob('image-optimize', { contentHash, preset: 'thumbnail', fileId });

            // Optionally queue OCR for images if enabled
            if (process.env.ENABLE_OCR === 'true') {
              await this.addJob('ocr-process', { contentHash, fileId });
            }

            return { success: true, status: 'visual' } satisfies IngestResult;
          }

          // Documents → text extraction
          if (mimeType && needsTextExtraction(mimeType)) {
            const result: TextExtractResult = await extractText({
              contentHash,
              fileId,
              mimeType,
              originalName: originalName || 'file'
            });

            const text = result.text || '';
            const hasText = !!(text && text.trim().length > 0);

            if (hasText) {
              await setPageCompleted(fileId, text, result.metadata || null, 'text');
              return { success: true, status: 'completed', textLength: text.length } satisfies IngestResult;
            }

            // No text found (likely scanned PDF) → visual, optionally queue OCR
            await setPageVisual(fileId);

            if (process.env.ENABLE_OCR === 'true') {
              await this.addJob('ocr-process', { contentHash, fileId });
            }
            return { success: true, status: 'visual' } satisfies IngestResult;
          }

          // Unsupported types → visual fallback
          await setPageVisual(fileId);
          return { success: true, status: 'visual' } satisfies IngestResult;

        } catch (error) {
          console.error(`ingest-file job failed for page ${fileId}:`, error);
          if (fileId) {
            await setPageFailed(fileId, error instanceof Error ? error.message : 'Unknown error');
          }
          throw error;
        }
      }
    );

    // Image optimization worker
    await this.boss.work('image-optimize',
      async ([job]) => {
        console.log(`Processing image job: ${job.id}`);
        return await processImage(job.data as ImageOptimizeJobData);
      }
    );

    // Text extraction worker
    await this.boss.work('text-extract',
      async ([job]) => {
        console.log(`Processing text extraction job: ${job.id}`);
        return await extractText(job.data as TextExtractJobData);
      }
    );

    // OCR worker
    await this.boss.work('ocr-process',
      async ([job]) => {
        console.log(`Processing OCR job: ${job.id}`);
        return await processOCR(job.data as OCRJobData);
      }
    );

    // Video processing worker
    await this.boss.work('video-process',
      async ([job]) => {
        loggers.processor.info(`Processing video job: ${job.id}`);
        const data = job.data as VideoProcessJobData;
        const result = await processVideo(data);
        if (result.success && data.fileId) {
          await setPageVideoProcessed(data.fileId, {
            duration: result.duration,
            width: result.width,
            height: result.height,
            thumbnailKey: result.thumbnailKey,
          });
        }
        return result;
      }
    );

    // SIEM delivery worker — cursor-based polling, ignores job data
    const { processSiemDelivery } = await import('./siem-delivery-worker');
    await this.boss.work('siem-delivery',
      async () => {
        await processSiemDelivery();
      }
    );

    // Schedule SIEM delivery every 30 seconds
    await this.boss.schedule('siem-delivery', '*/30 * * * * *', {}, { retryLimit: 0 });

    // Direct-to-S3 verified ingest: byte-verify (hash + Magika) before processing.
    await this.boss.work('pull-verify',
      async ([job]) => {
        // runPullPipeline sets the page's real status (visual/completed/failed);
        // this return is just the pg-boss job result.
        await runPullPipeline(job.data as PullVerifyJobData);
        return { success: true };
      }
    );

    // Durable GDPR account erasure (#906). Retries with backoff on throw; a
    // "blocked" outcome is recorded on the DSR row and is NOT retried.
    const { runAccountErasureJob } = await import('./account-erasure-worker');
    await this.boss.work('account-erasure',
      async ([job]) => {
        console.log(`Processing account-erasure job: ${job.id}`);
        await runAccountErasureJob(job.data as AccountErasureJobData);
        return { success: true };
      }
    );

    // Audit chainer — single-writer drain of the Admin PG ingest queue into
    // the security_audit_log hash chain (#890 Phase 2). Poll-based like
    // siem-delivery (ignores job data); no-ops when ADMIN_DATABASE_URL is
    // unset, and the run-level advisory lock serializes overlapping runs.
    const { processAuditChainer } = await import('./audit-chainer-worker');
    await this.boss.work('audit-chainer',
      async () => {
        await processAuditChainer();
      }
    );

    // Every 30 seconds, retryLimit 0 so overlapping runs won't stack (same
    // schedule contract as siem-delivery).
    await this.boss.schedule('audit-chainer', '*/30 * * * * *', {}, { retryLimit: 0 });

    // Durable admin-console email broadcast. Retries with backoff on throw; the
    // claim-before-send lease + UNIQUE(broadcastId, userId) ledger make a retry
    // resume from where the last attempt stopped instead of double-sending.
    const { runEmailBroadcastJob } = await import('./email-broadcast-worker');
    await this.boss.work('email-broadcast',
      async ([job]) => {
        console.log(`Processing email-broadcast job: ${job.id}`);
        await runEmailBroadcastJob(job.data as EmailBroadcastJobData);
        return { success: true };
      }
    );

    // Stuck-page reconciler (#2159) — closes the pages.processingStatus vs
    // pg-boss gap: pages stuck 'pending'/'processing' past the staleness
    // threshold with no live job get re-enqueued through pull-verify (tagged
    // with reconcileAttempt) or, once attempts are exhausted, marked 'failed'
    // with an alert. Poll-based like siem-delivery (ignores job data);
    // retryLimit 0 + run-level advisory lock keep overlapping runs from
    // double-enqueueing.
    const { runStuckPageReconciler, defaultReconcilerAlert } = await import('./stuck-page-reconciler-worker');
    const { getPoolForWorker } = await import('../db');
    await this.boss.work('stuck-page-reconciler',
      async () => {
        await runStuckPageReconciler({
          connect: () => getPoolForWorker().connect(),
          // singletonKey collapses racing re-enqueues for the same page into
          // one queued job; a duplicate rejection surfaces as an enqueue
          // error the worker logs and skips.
          enqueuePullVerify: (data) =>
            this.addJob('pull-verify', data, { singletonKey: `reconcile:${data.pageId}` }),
          alert: defaultReconcilerAlert,
        });
      }
    );

    // Every 5 minutes — minutes-scale detection is plenty for a gap that
    // previously went unnoticed for weeks, and each run is a few indexed reads.
    await this.boss.schedule('stuck-page-reconciler', '*/5 * * * *', {}, { retryLimit: 0 });
  }

  async addJob<Q extends QueueName>(
    queue: Q,
    data: JobDataMap[Q],
    options?: PgBoss.SendOptions
  ): Promise<string> {
    if (!this.boss) throw new Error('Queue manager not initialized');

    // Set priority based on queue type
    const priority = queue === 'image-optimize' ? 100 :
                    queue === 'text-extract' ? 50 :
                    queue === 'ingest-file' ? 60 : 10;

    // Retry policy. email-broadcast needs one that outlasts sendEmail's
    // per-recipient rate limiter: that limiter blocks for roughly an hour, the
    // worker surfaces blocked recipients as a terminal throw, and the default
    // 3×5s policy would burn every retry within seconds — leaving those
    // recipients recorded `failed` with no automatic retry ever reaching them.
    // Exponential backoff from 60s (60+120+…+30720s over 10 retries) reaches
    // multi-hour gaps by the later retries; the early ones may still find the
    // limiter's sliding window closed (each denied attempt nudges it forward),
    // which is why the tail of the schedule matters more than the head.
    //
    // expireInSeconds must dwarf the longest legitimate attempt: pg-boss's
    // default is 15 MINUTES, after which it fails the still-running job and
    // dispatches a retry that runs CONCURRENTLY with the original handler —
    // duplicate audience walks racing each other and the retry budget burning
    // on timeouts. Six hours covers ~40k recipients at the default 120ms
    // inter-send delay plus provider round-trips. The trade-off is crash
    // recovery: a SIGKILLed worker's job waits out this expiration before
    // retrying, which is acceptable for a queue this infrequent.
    const retryPolicy: Pick<
      PgBoss.SendOptions,
      'retryLimit' | 'retryDelay' | 'retryBackoff' | 'expireInSeconds'
    > =
      queue === 'email-broadcast'
        ? { retryLimit: 10, retryDelay: 60, retryBackoff: true, expireInSeconds: 6 * 60 * 60 }
        : { retryLimit: 3, retryDelay: 5 };

    // Caller options win over the per-queue defaults (a caller that passes
    // retryLimit/singletonKey knows something this table doesn't).
    const jobOptions = {
      priority,
      ...retryPolicy,
      ...options,
    };
    
    const jobId = await this.boss.send(queue, data, jobOptions);
    if (!jobId) {
      throw new Error(`Failed to queue job on ${queue} (duplicate or rejected)`);
    }
    console.log(`Queued job ${jobId} on ${queue}`);

    return jobId;
  }

  async getJob(jobId: string): Promise<ProcessingJob | null> {
    if (!this.boss) throw new Error('Queue manager not initialized');

    const job = await this.boss.getJobById('*', jobId);
    if (!job) return null;

    const data = job.data as Record<string, unknown> | undefined;
    const output = job.output as Record<string, unknown> | undefined;

    return {
      id: job.id,
      type: job.name as QueueName,
      fileId: (data?.fileId as string) ?? '',
      contentHash: (data?.contentHash as string) ?? '',
      status: mapJobState(job.state),
      result: output as ProcessingJob['result'],
      error: (output?.error as string) ?? undefined,
      createdAt: job.createdOn,
      completedAt: job.completedOn || undefined
    };
  }

  getQueueStatus(): Record<QueueName, QueueStats> {
    const queues: QueueName[] = ['ingest-file', 'pull-verify', 'image-optimize', 'text-extract', 'ocr-process', 'video-process', 'siem-delivery', 'account-erasure', 'audit-chainer', 'email-broadcast', 'stuck-page-reconciler'];
    const perQueue = this.cachedStates?.queues ?? {};

    const status = {} as Record<QueueName, QueueStats>;
    for (const queue of queues) {
      const q = perQueue[queue];
      status[queue] = q
        ? {
            pending: q.created + q.retry,
            active: q.active,
            completed: q.completed,
            failed: q.cancelled + q.failed,
          }
        : EMPTY_STATS;
    }

    return status;
  }

  async shutdown(): Promise<void> {
    if (this.boss) {
      await this.boss.stop();
      this.boss = null;
    }
  }
}
