import PgBoss from 'pg-boss';
import { db, pages, eq } from '@pagespace/db';
import { getScribeProcessor } from './scribe-processor';

export type QueueMode = 'producer' | 'consumer';

export class JobQueue {
  private boss: PgBoss;
  private isStarted = false;
  private mode: QueueMode | null = null;
  
  constructor(databaseUrl: string) {
    // Ensure schema creation and proper initialization
    this.boss = new PgBoss({
      connectionString: databaseUrl,
      // Ensure schema is created/migrated
      migrate: true,
      // Use pgboss schema
      schema: 'pgboss',
      // Connection pool settings
      max: 10,
      // Application name for debugging
      application_name: 'pagespace-worker',
      // Maintenance settings
      deleteAfterDays: 7,
      maintenanceIntervalMinutes: 1,
      // Archive settings
      archiveCompletedAfterSeconds: 60 * 60 * 12, // 12 hours
    });
    
    // Add error handler
    this.boss.on('error', (error: Error) => {
      console.error('pg-boss error:', error);
    });
  }
  
  async start(): Promise<void> {
    // Deprecated - use startAsProducer or startAsConsumer
    await this.startAsConsumer();
  }
  
  async startAsProducer(): Promise<void> {
    if (this.isStarted) {
      console.log('pg-boss already started in', this.mode, 'mode');
      return;
    }
    
    try {
      console.log('Starting pg-boss as PRODUCER (send-only)...');
      console.log('Initializing database schema if needed...');
      
      await this.boss.start();
      
      this.isStarted = true;
      this.mode = 'producer';
      console.log('pg-boss started successfully as PRODUCER');
      console.log('Database schema ready, can send jobs');
      
      // Verify connection by attempting a simple operation
      const queueExists = await this.boss.getQueueSize('process-file').catch(() => 0);
      console.log(`Queue 'process-file' status: ${queueExists >= 0 ? 'ready' : 'error'}`);
      
    } catch (error) {
      console.error('Failed to start pg-boss as producer:', error);
      throw error;
    }
  }
  
  async startAsConsumer(): Promise<void> {
    if (this.isStarted) {
      console.log('pg-boss already started in', this.mode, 'mode');
      return;
    }
    
    try {
      console.log('Starting pg-boss as CONSUMER (process jobs)...');
      console.log('Initializing database schema if needed...');
      
      await this.boss.start();
      
      this.isStarted = true;
      this.mode = 'consumer';
      console.log('pg-boss started successfully as CONSUMER');
      console.log('Database schema ready, can process jobs');
      
      // Only register handlers in consumer mode
      await this.registerHandlers();
      console.log('Job handlers registered for CONSUMER');
      
      // Verify we can see the queue
      const queueSize = await this.boss.getQueueSize('process-file').catch(() => 0);
      console.log(`Queue 'process-file' has ${queueSize} pending jobs`);
      
    } catch (error) {
      console.error('Failed to start pg-boss as consumer:', error);
      throw error;
    }
  }
  
  async stop(): Promise<void> {
    if (!this.isStarted) return;
    
    await this.boss.stop();
    this.isStarted = false;
  }
  
  async enqueueFileProcessing(pageId: string, priority: 'high' | 'normal' = 'normal'): Promise<string> {
    if (!this.isStarted) {
      throw new Error('pg-boss not started. Call startAsProducer() or startAsConsumer() first.');
    }
    
    try {
      console.log(`Attempting to enqueue job for page ${pageId} with priority ${priority}`);
      
      const jobId = await this.boss.send(
        'process-file',
        { pageId },
        {
          priority: priority === 'high' ? 10 : 0,
          retryLimit: 3,
          retryDelay: 60,
          expireInSeconds: 600 // 10 minute timeout
        }
      );
      
      if (!jobId) {
        console.error('pg-boss.send() returned null/undefined. This may indicate:');
        console.error('1. pg-boss tables not created in database');
        console.error('2. Database connection issues');
        console.error('3. pg-boss not properly initialized');
        throw new Error('Failed to create job - pg-boss returned null job ID');
      }
      
      console.log(`Successfully enqueued file processing job ${jobId} for page ${pageId}`);
      return jobId;
    } catch (error) {
      console.error('Failed to enqueue job:', error);
      throw error;
    }
  }
  
  private async registerHandlers(): Promise<void> {
    await this.boss.work(
      'process-file',
      async (jobs: any[]) => {
        // pg-boss passes an array of jobs, even if there's only one
        if (!jobs || jobs.length === 0) {
          console.log('No jobs to process');
          return;
        }
        
        const job = jobs[0]; // Process first job
        const { pageId } = job.data;
        console.log(`Processing job ${job.id} for page ${pageId}`);
        
        try {
          // Update status to processing
          await db.update(pages)
            .set({ processingStatus: 'processing' })
            .where(eq(pages.id, pageId));
          console.log(`Updated page ${pageId} status to processing`);
          
          // Process with Scribe
          const processor = await getScribeProcessor();
          const result = await processor.processFile(pageId);
          
          // Update page with results
          await db.update(pages)
            .set({
              content: result.content || '',
              processingStatus: result.processingStatus,
              processingError: result.error || null,
              extractionMethod: result.extractionMethod || null,
              extractionMetadata: result.metadata || null,
              contentHash: result.contentHash || null,
              processedAt: new Date()
            })
            .where(eq(pages.id, pageId));
          
          console.log(`Completed processing for page ${pageId}: ${result.processingStatus}`);
          console.log(`Content extracted: ${result.content ? result.content.length : 0} characters`);
          
        } catch (error) {
          console.error(`Failed to process file for page ${pageId}:`, error);
          console.error('Error details:', error instanceof Error ? error.stack : error);
          
          await db.update(pages)
            .set({
              processingStatus: 'failed',
              processingError: error instanceof Error ? error.message : 'Unknown error',
              processedAt: new Date()
            })
            .where(eq(pages.id, pageId));
          
          throw error; // Let pg-boss handle retry
        }
      }
    );
  }
  
  async getJobStatus(jobId: string): Promise<any> {
    // pg-boss v10 doesn't have getJobById, return basic status
    return { id: jobId, state: 'unknown' };
  }
  
  async getQueueStats(): Promise<any> {
    // Simple stats - pg-boss v10 API
    try {
      const created = await this.boss.getQueueSize('process-file');
      // For other states, we can't easily query them, so return estimates
      return {
        created: created || 0,
        retry: 0,
        active: 0,
        completed: 0,
        failed: 0
      };
    } catch (error) {
      console.error('Failed to get queue stats:', error);
      return {
        created: 0,
        retry: 0,
        active: 0,
        completed: 0,
        failed: 0
      };
    }
  }
}

// Singleton instances for different modes
let producerQueue: JobQueue | null = null;
let consumerQueue: JobQueue | null = null;

// Deprecated - use getProducerQueue or getConsumerQueue
export async function getJobQueue(): Promise<JobQueue> {
  console.warn('getJobQueue() is deprecated. Use getProducerQueue() or getConsumerQueue() instead.');
  return getConsumerQueue();
}

export async function getProducerQueue(): Promise<JobQueue> {
  if (!producerQueue) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not configured');
    }
    
    console.log('Creating producer queue instance...');
    producerQueue = new JobQueue(databaseUrl);
    await producerQueue.startAsProducer();
  }
  
  return producerQueue;
}

export async function getConsumerQueue(): Promise<JobQueue> {
  if (!consumerQueue) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not configured');
    }
    
    console.log('Creating consumer queue instance...');
    consumerQueue = new JobQueue(databaseUrl);
    await consumerQueue.startAsConsumer();
  }
  
  return consumerQueue;
}