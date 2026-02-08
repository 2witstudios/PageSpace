import { Router, type Router as RouterType } from 'express';
import { contentStore } from '../server';
import { isValidContentHash } from '../cache/content-store';

const router: RouterType = Router();

/**
 * DELETE /:contentHash
 * Deletes the original file and its cache for the given content hash.
 * Requires files:delete scope.
 */
router.delete('/:contentHash', async (req, res) => {
  const { contentHash } = req.params;

  if (!contentHash || !isValidContentHash(contentHash)) {
    return res.status(400).json({ error: 'Invalid content hash format' });
  }

  try {
    const { originalDeleted, cacheDeleted } = await contentStore.deleteOriginalAndCache(contentHash);

    console.log(
      `[delete-file] contentHash=${contentHash} originalDeleted=${originalDeleted} cacheDeleted=${cacheDeleted}`
    );

    if (!originalDeleted && !cacheDeleted) {
      return res.status(404).json({
        success: false,
        contentHash,
        originalDeleted,
        cacheDeleted,
      });
    }

    return res.json({
      success: true,
      contentHash,
      originalDeleted,
      cacheDeleted,
    });
  } catch (error) {
    console.error('[delete-file] Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to delete file',
    });
  }
});

export const deleteFileRouter: RouterType = router;
