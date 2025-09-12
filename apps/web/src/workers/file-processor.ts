#!/usr/bin/env node
import { getConsumerQueue } from '@pagespace/lib/job-queue';

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

let isShuttingDown = false;

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('Gracefully shutting down file processor worker...');
  
  const queue = await getConsumerQueue();
  await queue.stop();
  
  process.exit(0);
}

async function main() {
  console.log('Starting file processor worker...');
  console.log('Environment:', {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL ? 'Set' : 'Not set',
    FILE_STORAGE_PATH: process.env.FILE_STORAGE_PATH || 'Not set'
  });
  
  try {
    const queue = await getConsumerQueue(); // This starts the queue and registers handlers
    console.log('File processor worker started successfully');
    console.log('Worker is in CONSUMER mode - ready to process jobs');
    
    // Log queue stats periodically
    setInterval(async () => {
      try {
        const stats = await queue.getQueueStats();
        console.log('Queue stats:', stats);
      } catch (err) {
        console.error('Failed to get queue stats:', err);
      }
    }, 60000); // Every minute
    
  } catch (error) {
    console.error('Failed to start file processor worker:', error);
    process.exit(1);
  }
}

main();