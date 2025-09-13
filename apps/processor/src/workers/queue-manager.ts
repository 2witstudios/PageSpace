import PgBoss from 'pg-boss';
import { ProcessingJob } from '../types';

export class QueueManager {
  private boss: PgBoss | null = null;
  private connectionString: string;

  constructor() {
    this.connectionString = process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/pagespace';
  }

  async initialize(): Promise<void> {
    this.boss = new PgBoss({
      connectionString: this.connectionString,
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

    // High priority queue for image optimization
    // PgBoss queues are created automatically when first used

    // Normal priority queue for text extraction
    // Queues are created on first use

    // Low priority queue for OCR processing
    // Queues are created on first use
  }

  private async startWorkers(): Promise<void> {
    if (!this.boss) throw new Error('Queue manager not initialized');

    // Import worker functions
    const { processImage } = await import('./image-processor');
    const { extractText } = await import('./text-extractor');
    const { processOCR } = await import('./ocr-processor');

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
    queue: 'image-optimize' | 'text-extract' | 'ocr-process',
    data: any,
    options?: any
  ): Promise<string> {
    if (!this.boss) throw new Error('Queue manager not initialized');

    // Set priority based on queue type
    const priority = queue === 'image-optimize' ? 100 : 
                    queue === 'text-extract' ? 50 : 10;

    const jobOptions = {
      ...options,
      priority,
      retryLimit: 3,
      retryDelay: 5
    };
    
    const jobId = await this.boss.send(queue, data, jobOptions);

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

    const queues = ['image-optimize', 'text-extract', 'ocr-process'];
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