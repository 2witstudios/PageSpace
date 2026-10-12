/**
 * Org avatars (ORG-1): the image an org Owner or Admin uploads, stored under the org's own folder
 * and served by the web app (GET /api/orgs/:orgId/avatar/:filename, members only). Every write
 * needs a service token BOUND to that org (createOrgServiceToken, minted only for its Owner and
 * Admins); the scope alone is not enough.
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import {
  ORG_AVATAR_MAX_BYTES,
  ORG_AVATAR_MIME_TYPES,
  orgAvatarFilename,
  orgAvatarStorageKey,
} from '@pagespace/lib/organizations/org-avatar-core';
import { rateLimitUpload } from '../middleware/rate-limit';
import { processorLogger } from '../logger';
import { createS3Client, getS3Bucket } from '../s3-client';

const router: Router = Router();

router.use(rateLimitUpload);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ORG_AVATAR_MAX_BYTES },
  /* c8 ignore next 3 -- callback invoked by multer internals, not reachable in unit tests */
  fileFilter: (_req, file, cb) => {
    cb(null, ORG_AVATAR_MIME_TYPES.includes(file.mimetype));
  },
});

let _s3: ReturnType<typeof createS3Client> | null = null;
function s3() {
  if (!_s3) _s3 = createS3Client();
  return _s3;
}

/** Zero trust: the token must be bound to exactly this org, whatever its scopes say. */
function isBoundToOrg(req: Request, orgId: string): boolean {
  const binding = req.auth?.resourceBinding;
  return binding?.type === 'organization' && binding.id === orgId;
}

async function deleteOrgAvatars(orgId: string): Promise<void> {
  const bucket = getS3Bucket();
  const listed = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: orgAvatarStorageKey(orgId, '') }));
  const objects = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
  if (objects.length === 0) return;
  await s3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
}

function refuseUnbound(req: Request<{ orgId: string }>, res: Response): boolean {
  if (!req.auth) {
    res.status(401).json({ error: 'Service authentication required' });
    return true;
  }
  if (!isBoundToOrg(req, req.params.orgId)) {
    processorLogger.warn('Org avatar write refused: token not bound to this org', { orgId: req.params.orgId, userId: req.auth.userId });
    res.status(403).json({ error: 'Token is not bound to this organization' });
    return true;
  }
  return false;
}

router.post('/:orgId', upload.single('file'), async (req: Request<{ orgId: string }>, res: Response) => {
  if (refuseUnbound(req, res)) return;
  const { orgId } = req.params;
  const filename = req.file ? orgAvatarFilename(req.file.mimetype) : null;
  if (!req.file || !filename) {
    return res.status(400).json({ error: 'Upload a JPEG, PNG, GIF or WebP image' });
  }
  try {
    await deleteOrgAvatars(orgId);
    await s3().send(new PutObjectCommand({
      Bucket: getS3Bucket(),
      Key: orgAvatarStorageKey(orgId, filename),
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    return res.json({ filename });
  } catch (error) {
    processorLogger.error('Org avatar upload error', error instanceof Error ? error : null);
    return res.status(500).json({ error: 'Failed to upload organization avatar' });
  }
});

router.delete('/:orgId', async (req: Request<{ orgId: string }>, res: Response) => {
  if (refuseUnbound(req, res)) return;
  try {
    await deleteOrgAvatars(req.params.orgId);
    return res.json({ success: true });
  } catch (error) {
    processorLogger.error('Org avatar deletion error', error instanceof Error ? error : null);
    return res.status(500).json({ error: 'Failed to delete organization avatar' });
  }
});

export default router;
