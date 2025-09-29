import { Router, Request, Response } from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';
import { hasServiceScope } from '../middleware/auth';

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

// Avatar upload endpoint
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const auth = req.serviceAuth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const file = req.file;
    const userId = req.body.userId;

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (
      auth.userId &&
      userId !== auth.userId &&
      !hasServiceScope(auth, 'avatars:write:any')
    ) {
      return res.status(403).json({ error: 'Cannot modify avatar for another user' });
    }

    // Get storage path from environment
    const storagePath = process.env.FILE_STORAGE_PATH || '/data/files';
    const avatarsDir = path.join(storagePath, 'avatars', userId);

    // Create user's avatar directory if it doesn't exist
    await fs.mkdir(avatarsDir, { recursive: true });

    // Delete old avatar if it exists
    try {
      const files = await fs.readdir(avatarsDir);
      for (const oldFile of files) {
        if (oldFile.startsWith('avatar.')) {
          await fs.unlink(path.join(avatarsDir, oldFile));
        }
      }
    } catch (error) {
      // Directory might not exist yet, that's ok
    }

    // Save the new avatar
    const extension = path.extname(file.originalname) || '.jpg';
    const filename = `avatar${extension}`;
    const filepath = path.join(avatarsDir, filename);

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
    const auth = req.serviceAuth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (
      auth.userId &&
      userId !== auth.userId &&
      !hasServiceScope(auth, 'avatars:write:any')
    ) {
      return res.status(403).json({ error: 'Cannot delete avatar for another user' });
    }

    const storagePath = process.env.FILE_STORAGE_PATH || '/data/files';
    const avatarsDir = path.join(storagePath, 'avatars', userId);

    // Delete all avatar files for this user
    try {
      const files = await fs.readdir(avatarsDir);
      for (const file of files) {
        if (file.startsWith('avatar.')) {
          await fs.unlink(path.join(avatarsDir, file));
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
