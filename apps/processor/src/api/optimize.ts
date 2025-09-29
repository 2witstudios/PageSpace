import { Router, Request, Response } from 'express';
import type { Router as ExpressRouter } from 'express';
import { contentStore, queueManager } from '../server';
import { IMAGE_PRESETS } from '../types';
import { processImage, prepareImageForAI } from '../workers/image-processor';
import { InvalidContentHashError, isValidContentHash } from '../cache/content-store';
import { assertFileAccess } from '../services/rbac';

const router = Router();

// Optimize image endpoint - synchronous if cached, async if not
router.post('/', async (req, res) => {
  try {
    const auth = req.serviceAuth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const { contentHash, preset = 'ai-chat', fileId, waitForProcessing = false } = req.body;

    if (!contentHash) {
      return res.status(400).json({ error: 'contentHash is required' });
    }

    if (!isValidContentHash(contentHash)) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    const userId = auth.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    try {
      await assertFileAccess(userId, contentHash, 'view');
    } catch {
      return res.status(403).json({ error: 'Access denied for requested file' });
    }

    if (!IMAGE_PRESETS[preset]) {
      return res.status(400).json({ 
        error: 'Invalid preset',
        validPresets: Object.keys(IMAGE_PRESETS)
      });
    }

    // Check if already cached
    const cached = await contentStore.cacheExists(contentHash, preset);
    
    if (cached) {
      const url = await contentStore.getCacheUrl(contentHash, preset);
      return res.json({
        success: true,
        cached: true,
        url,
        status: 'completed'
      });
    }

    // If not cached and waitForProcessing is true, process synchronously
    if (waitForProcessing) {
      try {
        const result = await processImage({ contentHash, preset, fileId });
        return res.json({
          success: true,
          cached: false,
          url: result.url,
          status: 'completed',
          processingTime: result.processingTime
        });
      } catch (error) {
        return res.status(500).json({
          error: 'Processing failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Otherwise, queue for async processing
    const jobId = await queueManager.addJob('image-optimize', {
      contentHash,
      preset,
      fileId
    });

    res.json({
      success: true,
      cached: false,
      jobId,
      status: 'queued',
      checkUrl: `/api/job/${jobId}`
    });

  } catch (error) {
    if (error instanceof InvalidContentHashError) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    console.error('Optimization error:', error);
    res.status(500).json({
      error: 'Optimization failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Batch optimize endpoint for multiple presets
router.post('/batch', async (req, res) => {
  try {
    const auth = req.serviceAuth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const { contentHash, presets = ['ai-chat', 'thumbnail'], fileId } = req.body;

    if (!contentHash) {
      return res.status(400).json({ error: 'contentHash is required' });
    }

    if (!isValidContentHash(contentHash)) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    const userId = auth.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    try {
      await assertFileAccess(userId, contentHash, 'view');
    } catch {
      return res.status(403).json({ error: 'Access denied for requested file' });
    }

    const results: any = {};
    const jobIds: string[] = [];

    for (const preset of presets) {
      if (!IMAGE_PRESETS[preset]) {
        results[preset] = { error: 'Invalid preset' };
        continue;
      }

      // Check cache first
      const cached = await contentStore.cacheExists(contentHash, preset);
      
      if (cached) {
        results[preset] = {
          cached: true,
          url: await contentStore.getCacheUrl(contentHash, preset),
          status: 'completed'
        };
      } else {
        // Queue for processing
        const jobId = await queueManager.addJob('image-optimize', {
          contentHash,
          preset,
          fileId
        });
        
        jobIds.push(jobId);
        results[preset] = {
          cached: false,
          jobId,
          status: 'queued'
        };
      }
    }

    res.json({
      success: true,
      results,
      jobIds
    });

  } catch (error) {
    if (error instanceof InvalidContentHashError) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    console.error('Batch optimization error:', error);
    res.status(500).json({
      error: 'Batch optimization failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Prepare image for AI endpoint
router.post('/prepare-for-ai', async (req, res) => {
  try {
    const auth = req.serviceAuth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const { contentHash, provider = 'openai', returnBase64 = false } = req.body;

    if (!contentHash) {
      return res.status(400).json({ error: 'contentHash is required' });
    }

    if (!isValidContentHash(contentHash)) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    const userId = auth.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    try {
      await assertFileAccess(userId, contentHash, 'view');
    } catch {
      return res.status(403).json({ error: 'Access denied for requested file' });
    }

    // Prepare image optimized for AI
    const result = await prepareImageForAI(contentHash);

    // Some providers need base64
    if (returnBase64 || !providerSupportsUrls(provider)) {
      const buffer = await contentStore.getCache(contentHash, 'ai-chat');
      
      if (!buffer) {
        return res.status(404).json({ error: 'Optimized image not found' });
      }

      return res.json({
        success: true,
        type: 'base64',
        data: buffer.toString('base64'),
        mimeType: 'image/jpeg',
        size: result.size
      });
    }

    // Return URL for providers that support it
    res.json({
      success: true,
      type: 'url',
      url: result.url,
      size: result.size
    });

  } catch (error) {
    if (error instanceof InvalidContentHashError) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    console.error('AI preparation error:', error);
    res.status(500).json({
      error: 'AI preparation failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Helper function to check if provider supports URLs
function providerSupportsUrls(provider: string): boolean {
  const urlProviders = ['openai', 'anthropic', 'google'];
  return urlProviders.includes(provider.toLowerCase());
}

export const imageRouter: ExpressRouter = router;
