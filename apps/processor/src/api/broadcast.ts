import { Router, type Router as RouterType } from 'express';
import { queueManager } from '../server';

/**
 * Admin-console email-broadcast enqueue endpoint.
 *
 * The admin app mints a short-lived service token (scope `broadcast:enqueue`),
 * creates the email_broadcasts row, then calls this to put a durable job on the
 * pg-boss `email-broadcast` queue. Returns the jobId so the caller can record it
 * on the broadcast row (markQueued) for traceability. Mirrors `api/erasure.ts`.
 */

const router: RouterType = Router();

router.post('/enqueue', async (req, res) => {
  const auth = req.auth;
  if (!auth?.userId) {
    return res.status(401).json({ error: 'Service authentication required' });
  }

  const { broadcastId } = req.body ?? {};
  if (typeof broadcastId !== 'string' || !broadcastId) {
    return res.status(400).json({ error: 'broadcastId is required' });
  }

  try {
    const jobId = await queueManager.addJob('email-broadcast', { broadcastId });
    return res.json({ success: true, jobId });
  } catch (error) {
    console.error('[broadcast] enqueue failed:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to enqueue broadcast job',
    });
  }
});

export const broadcastRouter: RouterType = router;
