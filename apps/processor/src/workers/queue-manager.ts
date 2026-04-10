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
  TextExtractResult,
  IngestResult,
} from '../types';
import { setPageCompleted, setPageFailed, setPageProcessing, setPageVisual } from '../db';
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
      await this.boss.createQueue('image-optimize');
      await this.boss.createQueue('text-extract');
      await this.boss.createQueue('ocr-process');
      await this.boss.createQueue('siem-delivery');
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

    // SIEM delivery worker — cursor-based polling, ignores job data
    const { processSiemDelivery } = await import('./siem-delivery-worker');
    await this.boss.work('siem-delivery',
      async () => {
        await processSiemDelivery();
      }
    );

    // Schedule SIEM delivery every 30 seconds
    await this.boss.schedule('siem-delivery', '*/30 * * * * *', {}, { retryLimit: 0 });
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

    const jobOptions = {
      ...options,
      priority,
      retryLimit: 3,
      retryDelay: 5
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
    const queues: QueueName[] = ['ingest-file', 'image-optimize', 'text-extract', 'ocr-process', 'siem-delivery'];
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
