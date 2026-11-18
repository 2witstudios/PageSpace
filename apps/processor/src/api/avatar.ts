import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { hasAuthScope } from '../middleware/auth';
import { rateLimitUpload, rateLimitRead } from '../middleware/rate-limit';
import { processorLogger } from '../logger';
import { createS3Client, getS3Bucket } from '../s3-client';
import { AVATAR_NOT_AN_IMAGE_MESSAGE, AVATAR_REJECTED_MESSAGE } from '@pagespace/lib/content-safety/avatar-gate';
import { decideAvatarUpload, type AvatarUploadDecision } from '../services/avatar-gate-client';
import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';
import {
  DEFAULT_IMAGE_EXTENSION,
  normalizeIdentifier,
  sanitizeExtension,
  IDENTIFIER_PATTERN,
} from '../utils/security';

const router: Router = Router();

router.use(rateLimitUpload);

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  /* c8 ignore next 8 -- callback invoked by multer internals, not reachable in unit tests */
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  },
});

let _s3: ReturnType<typeof createS3Client> | null = null;
function s3() {
  if (!_s3) _s3 = createS3Client();
  return _s3;
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

function avatarKey(userId: string, ext: string): string {
  return `avatars/${userId}/avatar${ext}`;
}

export async function deleteUserAvatars(userId: string): Promise<void> {
  const bucket = getS3Bucket();
  const listed = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `avatars/${userId}/` }));
  const objects = listed.Contents ?? [];
  if (objects.length === 0) return;
  await s3().send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: objects.flatMap(o => o.Key ? [{ Key: o.Key }] : []), Quiet: true },
  }));
}

// Public read endpoint — serves avatar images directly.
// No service auth required; avatars are public.
router.get('/:userId/:filename', rateLimitRead, async (req: Request<{ userId: string; filename: string }>, res: Response) => {
  const userId = normalizeIdentifier(req.params.userId, IDENTIFIER_PATTERN);
  if (!userId) {
    return res.status(400).json({ error: 'Invalid user ID format' });
  }

  const ext = sanitizeExtension(req.params.filename, DEFAULT_IMAGE_EXTENSION);
  const key = avatarKey(userId, ext);

  try {
    const response = await s3().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }));
    if (!response.Body) return res.status(404).end();
    const bytes = await response.Body.transformToByteArray();
    const extension = ext.slice(1).toLowerCase();
    const contentType = CONTENT_TYPE_MAP[extension] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(Buffer.from(bytes));
  } catch (err) {
    const isNotFound = err && typeof err === 'object' && ('$metadata' in err
      ? (err as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode === 404
      : (err as { name?: string }).name === 'NoSuchKey');
    if (!isNotFound) processorLogger.warn('Avatar S3 read error', { key, err: String(err) });
    return res.status(404).end();
  }
});

// Avatar upload endpoint
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const auth = req.auth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const file = req.file;
    const userId = normalizeIdentifier(req.body.userId, IDENTIFIER_PATTERN);

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    if (!userId) {
      processorLogger.warn('Avatar upload rejected: invalid user ID', {
        providedUserId: req.body?.userId,
      });
      return res.status(400).json({ error: 'Invalid user ID format' });
    }

    if (
      auth.userId &&
      userId !== auth.userId &&
      !hasAuthScope(auth, 'avatars:write:any')
    ) {
      return res.status(403).json({ error: 'Cannot modify avatar for another user' });
    }

    // Content safety: decided on the bytes BEFORE the old avatar is touched, so a refused upload never
    // destroys the current one. The reason is never returned (see avatar-gate-client.ts).
    let decision: AvatarUploadDecision;
    try {
      decision = await decideAvatarUpload(new Uint8Array(file.buffer), userId);
    } catch (error) {
      processorLogger.error('Avatar gate failed; the upload is refused', error instanceof Error ? error : null, { userId });
      return res.status(422).json({ error: AVATAR_REJECTED_MESSAGE });
    }
    if (!decision.accept) {
      processorLogger.warn('Avatar upload refused', { userId, reason: decision.reason });
      return decision.reason === 'not_an_image'
        ? res.status(400).json({ error: AVATAR_NOT_AN_IMAGE_MESSAGE, code: 'not_an_image' })
        : res.status(422).json({ error: AVATAR_REJECTED_MESSAGE });
    }

    // Replace old avatar before writing new one (best-effort — don't fail the upload if cleanup fails)
    try { await deleteUserAvatars(userId); } catch { /* non-fatal */ }

    // The extension (which sets the served Content-Type) and the stored type come from the bytes,
    // never from the uploader's file name or declared type.
    const extension = decision.extension;
    const filename = `avatar${extension}`;
    const key = avatarKey(userId, extension);

    await s3().send(new PutObjectCommand({
      Bucket: getS3Bucket(),
      Key: key,
      Body: file.buffer,
      ContentType: decision.contentType,
    }));

    // Asked again now the avatar is stored, as a publish does after its copy: a takedown can block the hash while
    // the gate's answer was in flight, and no takedown step removes avatars by hash. Couldn't-check refuses too.
    const blockedSince = await isHashBlocked(decision.contentHash).catch(() => true);
    if (blockedSince) {
      await s3().send(new DeleteObjectsCommand({ Bucket: getS3Bucket(), Delete: { Objects: [{ Key: key }], Quiet: true } }));
      processorLogger.warn('Avatar upload refused: its hash was blocked while it was stored', { userId });
      return res.status(422).json({ error: AVATAR_REJECTED_MESSAGE });
    }

    res.json({
      success: true,
      filename,
      path: `/avatars/${userId}/${filename}`,
    });
  } catch (error) {
    processorLogger.error('Avatar upload error', error instanceof Error ? error : null);
    res.status(500).json({
      error: 'Failed to upload avatar',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Avatar deletion endpoint
router.delete('/:userId', async (req: Request, res: Response) => {
  try {
    const auth = req.auth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const userId = normalizeIdentifier(req.params.userId, IDENTIFIER_PATTERN);

    if (!userId) {
      processorLogger.warn('Avatar delete rejected: invalid user ID', {
        providedUserId: req.params?.userId,
      });
      return res.status(400).json({ error: 'Invalid user ID format' });
    }

    if (
      auth.userId &&
      userId !== auth.userId &&
      !hasAuthScope(auth, 'avatars:write:any')
    ) {
      return res.status(403).json({ error: 'Cannot delete avatar for another user' });
    }

    await deleteUserAvatars(userId);

    res.json({ success: true, message: 'Avatar deleted successfully' });
  } catch (error) {
    processorLogger.error('Avatar deletion error', error instanceof Error ? error : null);
    res.status(500).json({
      error: 'Failed to delete avatar',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
