import PgBoss from 'pg-boss';
import { ProcessingJob } from '../types';
import { setPageCompleted, setPageFailed, setPageProcessing, setPageVisual } from '../db';
import { needsTextExtraction } from './text-extractor';

export class QueueManager {
  private boss: PgBoss | null = null;
  private connectionString: string;

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
      { batchSize: 2 },
      async (jobs) => {
        const job = Array.isArray(jobs) ? jobs[0] : jobs;
        console.log(`Processing ingest-file job: ${job.id}`);
        const data = job.data as {
          contentHash: string;
          fileId: string; // pageId
          mimeType: string;
          originalName: string;
        };
        const { contentHash, fileId, mimeType, originalName } = data || {} as any;

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

            return { success: true, status: 'visual' };
          }

          // Documents → text extraction
          if (mimeType && needsTextExtraction(mimeType)) {
            const result = await extractText({
              contentHash,
              fileId,
              mimeType,
              originalName: originalName || 'file'
            });

            const text = (result as any)?.text || '';
            const hasText = !!(text && text.trim().length > 0);

            if (hasText) {
              await setPageCompleted(fileId, text, (result as any)?.metadata || null, 'text');
              return { success: true, status: 'completed', textLength: text.length };
            }

            // No text found (likely scanned PDF) → visual, optionally queue OCR
            await setPageVisual(fileId);

            if (process.env.ENABLE_OCR === 'true') {
              await this.addJob('ocr-process', { contentHash, fileId });
            }
            return { success: true, status: 'visual' };
          }

          // Unsupported types → visual fallback
          await setPageVisual(fileId);
          return { success: true, status: 'visual' };

        } catch (error) {
          console.error(`ingest-file job failed for page ${fileId}:`, error);
          await setPageFailed(fileId, error instanceof Error ? error.message : 'Unknown error');
          throw error;
        }
      }
    );

    // Image optimization worker (high concurrency)
    await this.boss.work('image-optimize', 
      { batchSize: 5 },
      async (jobs) => {
        const job = Array.isArray(jobs) ? jobs[0] : jobs;
        console.log(`Processing image job: ${job.id}`);
        return await processImage(job.data as any);
      }
    );

    // Text extraction worker (medium concurrency)
    await this.boss.work('text-extract',
      { batchSize: 3 },
      async (jobs) => {
        const job = Array.isArray(jobs) ? jobs[0] : jobs;
        console.log(`Processing text extraction job: ${job.id}`);
        return await extractText(job.data as any);
      }
    );

    // OCR worker (low concurrency due to API rate limits)
    await this.boss.work('ocr-process',
      { batchSize: 1 },
      async (jobs) => {
        const job = Array.isArray(jobs) ? jobs[0] : jobs;
        console.log(`Processing OCR job: ${job.id}`);
        return await processOCR(job.data as any);
      }
    );
  }

  async addJob(
    queue: 'ingest-file' | 'image-optimize' | 'text-extract' | 'ocr-process',
    data: any,
    options?: any
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
    console.log(`Queued job ${jobId} on ${queue}`);

    return jobId as string;
  }

  async getJob(jobId: string): Promise<ProcessingJob | null> {
    if (!this.boss) throw new Error('Queue manager not initialized');

    const job = await this.boss.getJobById('*', jobId);
    if (!job) return null;

    const data = job.data as any;
    const output = job.output as any;

    return {
      id: job.id,
      type: job.name as ProcessingJob['type'],
      fileId: data?.fileId,
      contentHash: data?.contentHash,
      status: this.mapJobState(job.state),
      result: output,
      error: output?.error,
      createdAt: job.createdOn,
      completedAt: job.completedOn || undefined
    };
  }

  private mapJobState(state: string): ProcessingJob['status'] {
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

  async getQueueStatus(): Promise<any> {
    if (!this.boss) throw new Error('Queue manager not initialized');

    const queues = ['ingest-file', 'image-optimize', 'text-extract', 'ocr-process'];
    const status: any = {};

    for (const queue of queues) {
      // PgBoss v10 uses different method signature
      const created = await this.boss.getQueueSize(queue, { before: 'active' });
      const active = await this.boss.getQueueSize(queue, { before: 'completed' });
      const completed = await this.boss.getQueueSize(queue, { before: 'failed' });
      const failed = await this.boss.getQueueSize(queue, { before: 'cancelled' });
      
      status[queue] = {
        active: active || 0,
        pending: created || 0,
        completed: completed || 0,
        failed: failed || 0
      };
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
