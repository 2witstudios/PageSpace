import { promises as fs } from 'fs';
import { createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CacheEntry } from '../types';

export class ContentStore {
  private cachePath: string;
  private storagePath: string;

  constructor(cachePath: string, storagePath: string) {
    this.cachePath = cachePath;
    this.storagePath = storagePath;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.cachePath, { recursive: true });
    await fs.mkdir(this.storagePath, { recursive: true });
  }

  async getCachePath(contentHash: string, preset: string): Promise<string> {
    return path.join(this.cachePath, contentHash, `${preset}.jpg`);
  }

  async getOriginalPath(contentHash: string): Promise<string> {
    return path.join(this.storagePath, contentHash, 'original');
  }

  async cacheExists(contentHash: string, preset: string): Promise<boolean> {
    const cachePath = await this.getCachePath(contentHash, preset);
    try {
      await fs.access(cachePath);
      return true;
    } catch {
      return false;
    }
  }

  async saveCache(
    contentHash: string,
    preset: string,
    buffer: Buffer,
    mimeType: string
  ): Promise<CacheEntry> {
    const cachePath = await this.getCachePath(contentHash, preset);
    const dir = path.dirname(cachePath);
    
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cachePath, buffer);

    const entry: CacheEntry = {
      contentHash,
      preset,
      path: cachePath,
      size: buffer.length,
      mimeType,
      createdAt: new Date(),
      lastAccessed: new Date()
    };

    // Save metadata
    const metadataPath = path.join(dir, 'metadata.json');
    let metadata: Record<string, CacheEntry> = {};
    
    try {
      const existing = await fs.readFile(metadataPath, 'utf-8');
      metadata = JSON.parse(existing);
    } catch {
      // File doesn't exist yet
    }

    metadata[preset] = entry;
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    return entry;
  }

  async getCache(contentHash: string, preset: string): Promise<Buffer | null> {
    const cachePath = await this.getCachePath(contentHash, preset);
    try {
      const buffer = await fs.readFile(cachePath);
      
      // Update last accessed time
      const metadataPath = path.join(path.dirname(cachePath), 'metadata.json');
      try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        if (metadata[preset]) {
          metadata[preset].lastAccessed = new Date();
          await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
        }
      } catch {
        // Ignore metadata update errors
      }

      return buffer;
    } catch {
      return null;
    }
  }

  async saveOriginal(buffer: Buffer, originalName: string): Promise<{ contentHash: string; path: string }> {
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const originalPath = await this.getOriginalPath(contentHash);
    const dir = path.dirname(originalPath);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(originalPath, buffer);

    // Save original metadata
    const metadataPath = path.join(dir, 'metadata.json');
    const metadata = {
      originalName,
      contentHash,
      size: buffer.length,
      savedAt: new Date()
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    return { contentHash, path: originalPath };
  }

  /**
   * Save original file from disk path (more memory efficient than buffer method)
   * This method avoids loading the entire file into memory for large files
   */
  async saveOriginalFromFile(
    tempFilePath: string,
    originalName: string,
    precomputedHash?: string
  ): Promise<{ contentHash: string; path: string }> {
    const contentHash = precomputedHash ?? await this.hashFile(tempFilePath);
    const originalPath = await this.getOriginalPath(contentHash);
    const dir = path.dirname(originalPath);

    await fs.mkdir(dir, { recursive: true });

    // Move/copy the file from temp location to final location
    await fs.copyFile(tempFilePath, originalPath);

    // Get file stats for metadata
    const stats = await fs.stat(originalPath);

    // Save original metadata
    const metadataPath = path.join(dir, 'metadata.json');
    const metadata = {
      originalName,
      contentHash,
      size: stats.size,
      savedAt: new Date()
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    return { contentHash, path: originalPath };
  }

  async originalExists(contentHash: string): Promise<boolean> {
    try {
      const originalPath = await this.getOriginalPath(contentHash);
      await fs.access(originalPath);
      return true;
    } catch {
      return false;
    }
  }

  private async hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);

      stream.on('error', reject);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async getOriginal(contentHash: string): Promise<Buffer | null> {
    const originalPath = await this.getOriginalPath(contentHash);
    try {
      return await fs.readFile(originalPath);
    } catch {
      return null;
    }
  }

  async getCacheUrl(contentHash: string, preset: string): Promise<string> {
    // Return the URL path that will be served
    return `/cache/${contentHash}/${preset}`;
  }

  async cleanupOldCache(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    let deletedCount = 0;
    const now = Date.now();

    const contentDirs = await fs.readdir(this.cachePath);
    
    for (const contentHash of contentDirs) {
      const dirPath = path.join(this.cachePath, contentHash);
      const metadataPath = path.join(dirPath, 'metadata.json');
      
      try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        
        for (const [preset, entry] of Object.entries(metadata as Record<string, CacheEntry>)) {
          const lastAccessed = new Date(entry.lastAccessed).getTime();
          
          if (now - lastAccessed > maxAgeMs) {
            const filePath = path.join(dirPath, `${preset}.jpg`);
            try {
              await fs.unlink(filePath);
              delete metadata[preset];
              deletedCount++;
            } catch {
              // File already deleted
            }
          }
        }

        // Update metadata or remove directory if empty
        if (Object.keys(metadata).length === 0) {
          await fs.rmdir(dirPath, { recursive: true });
        } else {
          await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
        }
      } catch {
        // Skip directories without metadata
      }
    }

    return deletedCount;
  }
}
