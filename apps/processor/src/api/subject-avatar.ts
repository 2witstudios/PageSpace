/**
 * Subject avatars (an org's: ORG-1; a drive's): the image an Owner or Admin uploads, stored under the
 * subject's own folder and served by the web app (GET /api/orgs/:id/avatar/:filename or
 * /api/drives/:id/avatar/:filename, members only). Every write needs a service token BOUND to that
 * org or drive (createOrgServiceToken / createDriveServiceToken, minted only for its Owner and
 * Admins); the scope alone is not enough.
 *
 * An upload never overwrites or deletes: it writes a new file (avatar-<nonce>.<ext>) and returns its
 * name. The web route switches the stored path to it and only then deletes the file it replaced, by
 * name (DELETE /:id/:filename); DELETE /:id empties the folder when the subject itself is gone.
 */
import { randomBytes } from 'crypto';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  avatarFilename,
  avatarStorageKey,
  isAvatarFilename,
  type AvatarSubject,
} from '@pagespace/lib/avatars/avatar-core';
import { rateLimitUpload } from '../middleware/rate-limit';
import { processorLogger } from '../logger';
import { createS3Client, getS3Bucket } from '../s3-client';

/** The token binding each subject's writes require, and the words its errors use. */
const SUBJECTS: Readonly<Record<AvatarSubject, { binding: string; label: string; a: string; Label: string }>> = {
  org: { binding: 'organization', label: 'organization', a: 'an', Label: 'Org' },
  drive: { binding: 'drive', label: 'drive', a: 'a', Label: 'Drive' },
};

let _s3: ReturnType<typeof createS3Client> | null = null;
function s3() {
  if (!_s3) _s3 = createS3Client();
  return _s3;
}

/**
 * Empties a subject's whole avatar folder: when the org or drive itself is gone (DELETE /:id), or
 * from inside the processor when account erasure deletes a drive (no token: the worker is trusted).
 */
export async function deleteSubjectAvatars(subject: AvatarSubject, id: string): Promise<void> {
  const bucket = getS3Bucket();
  const listed = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: avatarStorageKey(subject, id, '') }));
  const objects = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
  if (objects.length === 0) return;
  await s3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
}

export function createAvatarRouter(subject: AvatarSubject): Router {
  const { binding: bindingType, label, a, Label } = SUBJECTS[subject];
  const router: Router = Router();

  router.use(rateLimitUpload);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_BYTES },
    /* c8 ignore next 3 -- callback invoked by multer internals, not reachable in unit tests */
    fileFilter: (_req, file, cb) => {
      cb(null, AVATAR_MIME_TYPES.includes(file.mimetype));
    },
  });

  /** Zero trust: the token must be bound to exactly this org or drive, whatever its scopes say. */
  function isBoundTo(req: Request, id: string): boolean {
    const binding = req.auth?.resourceBinding;
    return binding?.type === bindingType && binding.id === id;
  }

  function refuseUnbound(req: Request<{ id: string }>, res: Response): boolean {
    if (!req.auth) {
      res.status(401).json({ error: 'Service authentication required' });
      return true;
    }
    if (!isBoundTo(req, req.params.id)) {
      processorLogger.warn(`${Label} avatar write refused: token not bound to this ${label}`, { [`${subject}Id`]: req.params.id, userId: req.auth.userId });
      res.status(403).json({ error: `Token is not bound to this ${label}` });
      return true;
    }
    return false;
  }

  router.post('/:id', upload.single('file'), async (req: Request<{ id: string }>, res: Response) => {
    if (refuseUnbound(req, res)) return;
    const { id } = req.params;
    // A fresh name per upload: concurrent uploads never write the same object.
    const filename = req.file ? avatarFilename(req.file.mimetype, randomBytes(12).toString('hex')) : null;
    if (!req.file || !filename) {
      return res.status(400).json({ error: 'Upload a JPEG, PNG, GIF or WebP image' });
    }
    try {
      await s3().send(new PutObjectCommand({
        Bucket: getS3Bucket(),
        Key: avatarStorageKey(subject, id, filename),
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));
      return res.json({ filename });
    } catch (error) {
      processorLogger.error(`${Label} avatar upload error`, error instanceof Error ? error : null);
      return res.status(500).json({ error: `Failed to upload ${label} avatar` });
    }
  });

  router.delete('/:id/:filename', async (req: Request<{ id: string; filename: string }>, res: Response) => {
    if (refuseUnbound(req, res)) return;
    const { id, filename } = req.params;
    if (!isAvatarFilename(filename)) return res.status(400).json({ error: `Not ${a} ${label} avatar file` });
    try {
      await s3().send(new DeleteObjectsCommand({
        Bucket: getS3Bucket(),
        Delete: { Objects: [{ Key: avatarStorageKey(subject, id, filename) }], Quiet: true },
      }));
      return res.json({ success: true });
    } catch (error) {
      processorLogger.error(`${Label} avatar file deletion error`, error instanceof Error ? error : null);
      return res.status(500).json({ error: `Failed to delete ${label} avatar` });
    }
  });

  router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
    if (refuseUnbound(req, res)) return;
    try {
      await deleteSubjectAvatars(subject, req.params.id);
      return res.json({ success: true });
    } catch (error) {
      processorLogger.error(`${Label} avatar deletion error`, error instanceof Error ? error : null);
      return res.status(500).json({ error: `Failed to delete ${label} avatar` });
    }
  });

  return router;
}
