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
    // singletonKey dedupes at the layer that owns job identity: a double-click
    // or a retried POST (lost response) must not start a second concurrent walk
    // of the same audience. The per-recipient claim ledger stays the LAST line
    // of defence, not the only one. pg-boss releases the key once the job
    // completes, so re-enqueueing a paused/refused broadcast still works.
    const jobId = await queueManager.addJob(
      'email-broadcast',
      { broadcastId },
      { singletonKey: broadcastId },
    );
    return res.json({ success: true, jobId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to enqueue broadcast job';
    // addJob surfaces pg-boss's null jobId (singleton conflict) as this throw.
    if (message.includes('duplicate or rejected')) {
      return res.status(409).json({
        error: 'A job for this broadcast is already queued or running',
      });
    }
    console.error('[broadcast] enqueue failed:', error);
    return res.status(500).json({ error: message });
  }
});

export const broadcastRouter: RouterType = router;
