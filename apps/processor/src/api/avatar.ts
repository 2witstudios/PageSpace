import { Router, Request, Response } from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';
import { hasAuthScope } from '../middleware/auth';
import { processorLogger } from '../logger';
import {
  DEFAULT_IMAGE_EXTENSION,
  normalizeIdentifier,
  resolvePathWithin,
  sanitizeExtension,
  IDENTIFIER_PATTERN,
} from '../utils/security';

const router: Router = Router();

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow only image files
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  },
});

const STORAGE_ROOT = path.resolve(process.env.FILE_STORAGE_PATH || '/data/files');
const AVATAR_ROOT = resolvePathWithin(STORAGE_ROOT, 'avatars');

if (!AVATAR_ROOT) {
  throw new Error('Invalid avatar storage configuration');
}

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
        providedUserId: req.body?.userId
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

    const avatarsDir = resolvePathWithin(AVATAR_ROOT, userId);
    if (!avatarsDir) {
      processorLogger.warn('Avatar upload rejected: unsafe directory resolution', {
        userId
      });
      return res.status(400).json({ error: 'Invalid avatar path' });
    }

    // Create user's avatar directory if it doesn't exist
    await fs.mkdir(avatarsDir, { recursive: true });

    // Delete old avatar if it exists
    try {
      const files = await fs.readdir(avatarsDir);
      for (const oldFile of files) {
        if (oldFile.startsWith('avatar.')) {
          const safeOldPath = resolvePathWithin(avatarsDir, oldFile);
          if (safeOldPath) {
            await fs.unlink(safeOldPath);
          }
        }
      }
    } catch (error) {
      // Directory might not exist yet, that's ok
    }

    // Save the new avatar
    const extension = sanitizeExtension(file.originalname, DEFAULT_IMAGE_EXTENSION);
    const filename = `avatar${extension}`;
    const filepath = resolvePathWithin(avatarsDir, filename);

    if (!filepath) {
      processorLogger.warn('Avatar upload rejected: unsafe file path resolution', {
        userId,
        filename
      });
      return res.status(400).json({ error: 'Invalid avatar path' });
    }

    await fs.writeFile(filepath, file.buffer);

    res.json({
      success: true,
      filename,
      path: `/avatars/${userId}/${filename}`,
    });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({
      error: 'Failed to upload avatar',
      details: error instanceof Error ? error.message : 'Unknown error'
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
        providedUserId: req.params?.userId
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

    const avatarsDir = resolvePathWithin(AVATAR_ROOT, userId);

    if (!avatarsDir) {
      processorLogger.warn('Avatar delete rejected: unsafe directory resolution', {
        userId
      });
      return res.status(400).json({ error: 'Invalid avatar path' });
    }

    // Delete all avatar files for this user
    try {
      const files = await fs.readdir(avatarsDir);
      for (const file of files) {
        if (file.startsWith('avatar.')) {
          const filePath = resolvePathWithin(avatarsDir, file);
          if (filePath) {
            await fs.unlink(filePath);
          }
        }
      }
      // Optionally remove the empty directory
      await fs.rmdir(avatarsDir);
    } catch (error) {
      // Directory or files might not exist, that's ok
      console.log('Avatar deletion - directory not found or already empty');
    }

    res.json({
      success: true,
      message: 'Avatar deleted successfully',
    });
  } catch (error) {
    console.error('Avatar deletion error:', error);
    res.status(500).json({
      error: 'Failed to delete avatar',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
