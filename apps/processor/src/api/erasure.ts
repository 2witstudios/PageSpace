import { Router, type Router as RouterType } from 'express';
import { queueManager } from '../server';

/**
 * GDPR account-erasure enqueue endpoint (#906).
 *
 * The web app mints a short-lived service token (scope `erasure:enqueue`),
 * creates the data_subject_requests row, then calls this to put a durable job
 * on the pg-boss `account-erasure` queue. Returns the jobId so the web app can
 * record it on the DSR row for traceability.
 */

const router: RouterType = Router();

router.post('/enqueue', async (req, res) => {
  const auth = req.auth;
  if (!auth?.userId) {
    return res.status(401).json({ error: 'Service authentication required' });
  }

  const { requestId, userId } = req.body ?? {};
  if (typeof requestId !== 'string' || typeof userId !== 'string' || !requestId || !userId) {
    return res.status(400).json({ error: 'requestId and userId are required' });
  }

  try {
    const jobId = await queueManager.addJob('account-erasure', { requestId, userId });
    return res.json({ success: true, jobId });
  } catch (error) {
    console.error('[erasure] enqueue failed:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to enqueue erasure job',
    });
  }
});

export const erasureRouter: RouterType = router;
