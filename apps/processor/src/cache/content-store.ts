import { promises as fs } from 'fs';
import { createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CacheEntry } from '../types';

export const CONTENT_HASH_REGEX = /^[a-f0-9]{64}$/i;

/**
 * Validate that a preset name is safe for use as a filename and property key.
 * Allows alphanumeric, hyphens, underscores, and dots (for presets like
 * "extracted-text.txt", "ocr-text.txt", "thumbnail.webp").
 * Rejects ".." sequences to prevent path traversal.
 */
const SAFE_PRESET_REGEX = /^[a-zA-Z0-9_.\-]{1,64}$/;
export function isValidPreset(preset: string): boolean {
  return typeof preset === 'string' && SAFE_PRESET_REGEX.test(preset) && !preset.includes('..');
}

/**
 * Prototype-pollution-safe property keys that must never be used as dynamic keys.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafePropertyKey(key: string): boolean {
  return !FORBIDDEN_KEYS.has(key);
}

/**
 * Assert that a resolved path is contained within the expected base directory.
 * Prevents path traversal even if upstream validation is bypassed.
 */
function assertPathWithin(resolvedPath: string, baseDir: string): void {
  const normalizedResolved = path.resolve(resolvedPath);
  const normalizedBase = path.resolve(baseDir);
  if (!normalizedResolved.startsWith(normalizedBase + path.sep) && normalizedResolved !== normalizedBase) {
    throw new Error('Path escapes base directory');
  }
}

export function isValidContentHash(contentHash: string): boolean {
  return typeof contentHash === 'string' && CONTENT_HASH_REGEX.test(contentHash);
}

export class InvalidContentHashError extends Error {
  constructor(contentHash: string) {
    super('Invalid content hash format');
    this.name = 'InvalidContentHashError';
    this.contentHash = contentHash;
  }

  contentHash: string;
}

export interface OriginalUploadRecord {
  tenantId?: string;
  userId?: string;
  driveId?: string;
  service?: string;
  uploadedAt: string;
}

export interface OriginalFileMetadata {
  originalName: string;
  contentHash: string;
  size: number;
  savedAt: string;
  tenants?: string[];
  drives?: string[];
  uploads?: OriginalUploadRecord[];
  lastAccessedAt?: string;
}

export interface SaveOriginalOptions {
  tenantId?: string;
  userId?: string;
  driveId?: string;
  service?: string;
}

export class ContentStore {
  private cachePath: string;
  private storagePath: string;

  constructor(cachePath: string, storagePath: string) {
    this.cachePath = cachePath;
    this.storagePath = storagePath;
  }

  private normalizeContentHash(contentHash: string): string {
    if (!isValidContentHash(contentHash)) {
      throw new InvalidContentHashError(contentHash);
    }

    return contentHash.toLowerCase();
  }

  private getCacheDir(normalizedHash: string): string {
    return path.join(this.cachePath, normalizedHash);
  }

  private getOriginalDir(normalizedHash: string): string {
    return path.join(this.storagePath, normalizedHash);
  }

  private getCacheFilePath(normalizedHash: string, preset: string): string {
    if (!isValidPreset(preset)) {
      throw new Error('Invalid preset name');
    }
    const filePath = path.join(this.getCacheDir(normalizedHash), `${preset}.jpg`);
    assertPathWithin(filePath, this.cachePath);
    return filePath;
  }

  private getCacheMetadataPath(normalizedHash: string): string {
    const metadataPath = path.join(this.getCacheDir(normalizedHash), 'metadata.json');
    assertPathWithin(metadataPath, this.cachePath);
    return metadataPath;
  }

  private getOriginalFilePath(normalizedHash: string): string {
    const filePath = path.join(this.getOriginalDir(normalizedHash), 'original');
    assertPathWithin(filePath, this.storagePath);
    return filePath;
  }

  private getOriginalMetadataPath(normalizedHash: string): string {
    const metadataPath = path.join(this.getOriginalDir(normalizedHash), 'metadata.json');
    assertPathWithin(metadataPath, this.storagePath);
    return metadataPath;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.cachePath, { recursive: true });
    await fs.mkdir(this.storagePath, { recursive: true });
  }

  private normalizeOriginalMetadata(data: any): OriginalFileMetadata {
    const metadata: OriginalFileMetadata = {
      originalName: typeof data?.originalName === 'string' ? data.originalName : 'file',
      contentHash: typeof data?.contentHash === 'string' ? data.contentHash : '',
      size: typeof data?.size === 'number' ? data.size : 0,
      savedAt: typeof data?.savedAt === 'string' ? data.savedAt : new Date().toISOString(),
      tenants: Array.isArray(data?.tenants)
        ? Array.from(new Set(data.tenants.filter((item: unknown) => typeof item === 'string')))
        : undefined,
      drives: Array.isArray(data?.drives)
        ? Array.from(new Set(data.drives.filter((item: unknown) => typeof item === 'string')))
        : undefined,
      uploads: Array.isArray(data?.uploads)
        ? data.uploads
            .map((entry: any) => ({
              tenantId: typeof entry?.tenantId === 'string' ? entry.tenantId : undefined,
              userId: typeof entry?.userId === 'string' ? entry.userId : undefined,
              driveId: typeof entry?.driveId === 'string' ? entry.driveId : undefined,
              service: typeof entry?.service === 'string' ? entry.service : undefined,
              uploadedAt:
                typeof entry?.uploadedAt === 'string'
                  ? entry.uploadedAt
                  : new Date().toISOString()
            }))
        : undefined,
      lastAccessedAt:
        typeof data?.lastAccessedAt === 'string' ? data.lastAccessedAt : undefined
    };

    if (!metadata.contentHash) {
      metadata.contentHash = crypto.createHash('sha256').update(`${metadata.originalName}:${metadata.size}`).digest('hex');
    }

    return metadata;
  }

  private async writeOriginalMetadata(normalizedHash: string, metadata: OriginalFileMetadata): Promise<void> {
    const metadataPath = this.getOriginalMetadataPath(normalizedHash);
    const dir = path.dirname(metadataPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  async getOriginalMetadata(contentHash: string): Promise<OriginalFileMetadata | null> {
    let normalizedHash: string;
    try {
      normalizedHash = this.normalizeContentHash(contentHash);
    } catch (error) {
      if (error instanceof InvalidContentHashError) {
        return null;
      }
      throw error;
    }

    try {
      const raw = await fs.readFile(this.getOriginalMetadataPath(normalizedHash), 'utf-8');
      const data = JSON.parse(raw);
      return this.normalizeOriginalMetadata(data);
    } catch {
      return null;
    }
  }

  async appendUploadMetadata(contentHash: string, options: SaveOriginalOptions = {}): Promise<void> {
    const normalizedHash = this.normalizeContentHash(contentHash);
    const metadata = (await this.getOriginalMetadata(normalizedHash)) ?? {
      originalName: 'file',
      contentHash: normalizedHash,
      size: 0,
      savedAt: new Date().toISOString()
    };

    metadata.tenants = this.mergeUnique(metadata.tenants, options.tenantId);
    metadata.drives = this.mergeUnique(metadata.drives, options.driveId);

    const uploads = metadata.uploads ?? [];
    uploads.push({
      tenantId: options.tenantId,
      userId: options.userId,
      driveId: options.driveId,
      service: options.service,
      uploadedAt: new Date().toISOString()
    });
    metadata.uploads = uploads;

    await this.writeOriginalMetadata(normalizedHash, metadata);
  }

  private mergeUnique(collection: string[] | undefined, value?: string): string[] | undefined {
    if (!value) {
      return collection;
    }

    const result = new Set(collection ?? []);
    result.add(value);
    return Array.from(result);
  }

  async tenantHasAccess(contentHash: string, tenantId: string | undefined | null): Promise<boolean> {
    if (!tenantId) {
      return false;
    }

    const metadata = await this.getOriginalMetadata(contentHash);
    if (!metadata) {
      return false;
    }

    if (!metadata.tenants || metadata.tenants.length === 0) {
      return true;
    }

    return metadata.tenants.includes(tenantId);
  }

  async getCachePath(contentHash: string, preset: string): Promise<string> {
    const normalizedHash = this.normalizeContentHash(contentHash);
    return this.getCacheFilePath(normalizedHash, preset);
  }

  async getOriginalPath(contentHash: string): Promise<string> {
    const normalizedHash = this.normalizeContentHash(contentHash);
    return this.getOriginalFilePath(normalizedHash);
  }

  async cacheExists(contentHash: string, preset: string): Promise<boolean> {
    let cachePath: string;
    try {
      cachePath = await this.getCachePath(contentHash, preset);
    } catch (error) {
      if (error instanceof InvalidContentHashError) {
        return false;
      }
      throw error;
    }

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
    const normalizedHash = this.normalizeContentHash(contentHash);
    const cachePath = this.getCacheFilePath(normalizedHash, preset);
    const dir = path.dirname(cachePath);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cachePath, buffer);

    const entry: CacheEntry = {
      contentHash: normalizedHash,
      preset,
      path: cachePath,
      size: buffer.length,
      mimeType,
      createdAt: new Date(),
      lastAccessed: new Date()
    };

    const metadataPath = this.getCacheMetadataPath(normalizedHash);
    let metadata: Record<string, CacheEntry> = Object.create(null);

    try {
      const existing = await fs.readFile(metadataPath, 'utf-8');
      const parsed = JSON.parse(existing);
      // Copy only safe keys to null-prototype object
      for (const key of Object.keys(parsed)) {
        if (isSafePropertyKey(key) && isValidPreset(key)) {
          metadata[key] = parsed[key];
        }
      }
    } catch {
      // File doesn't exist yet
    }

    if (isValidPreset(preset)) {
      metadata[preset] = entry;
    }
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    return entry;
  }

  async getCache(contentHash: string, preset: string): Promise<Buffer | null> {
    let cachePath: string;
    try {
      cachePath = await this.getCachePath(contentHash, preset);
    } catch (error) {
      if (error instanceof InvalidContentHashError) {
        return null;
      }
      throw error;
    }

    try {
      const buffer = await fs.readFile(cachePath);

      const metadataPath = this.getCacheMetadataPath(this.normalizeContentHash(contentHash));
      try {
        const rawParsed = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        const metadata: Record<string, any> = Object.create(null);
        for (const key of Object.keys(rawParsed)) {
          if (isSafePropertyKey(key) && isValidPreset(key)) {
            metadata[key] = rawParsed[key];
          }
        }
        if (isValidPreset(preset) && preset in metadata) {
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

  async saveOriginal(
    buffer: Buffer,
    originalName: string,
    options: SaveOriginalOptions = {}
  ): Promise<{ contentHash: string; path: string }> {
    const rawHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const normalizedHash = this.normalizeContentHash(rawHash);
    const originalPath = this.getOriginalFilePath(normalizedHash);
    const dir = path.dirname(originalPath);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(originalPath, buffer);

    const metadata: OriginalFileMetadata = {
      originalName,
      contentHash: normalizedHash,
      size: buffer.length,
      savedAt: new Date().toISOString()
    };

    await this.writeOriginalMetadata(normalizedHash, metadata);
    await this.appendUploadMetadata(normalizedHash, options);

    return { contentHash: normalizedHash, path: originalPath };
  }

  async saveOriginalFromFile(
    tempFilePath: string,
    originalName: string,
    precomputedHash?: string,
    options: SaveOriginalOptions = {}
  ): Promise<{ contentHash: string; path: string }> {
    const rawHash = precomputedHash ?? await this.hashFile(tempFilePath);
    const normalizedHash = this.normalizeContentHash(rawHash);
    const originalPath = this.getOriginalFilePath(normalizedHash);
    const dir = path.dirname(originalPath);

    await fs.mkdir(dir, { recursive: true });

    await fs.copyFile(tempFilePath, originalPath);

    const stats = await fs.stat(originalPath);

    const metadata: OriginalFileMetadata = {
      originalName,
      contentHash: normalizedHash,
      size: stats.size,
      savedAt: new Date().toISOString()
    };

    await this.writeOriginalMetadata(normalizedHash, metadata);
    await this.appendUploadMetadata(normalizedHash, options);

    return { contentHash: normalizedHash, path: originalPath };
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
    let originalPath: string;
    try {
      originalPath = await this.getOriginalPath(contentHash);
    } catch (error) {
      if (error instanceof InvalidContentHashError) {
        return null;
      }
      throw error;
    }

    try {
      const buffer = await fs.readFile(originalPath);
      const metadata = await this.getOriginalMetadata(contentHash);
      if (metadata) {
        metadata.lastAccessedAt = new Date().toISOString();
        const normalizedHash = this.normalizeContentHash(contentHash);
        await this.writeOriginalMetadata(normalizedHash, metadata);
      }
      return buffer;
    } catch {
      return null;
    }
  }

  async getCacheUrl(contentHash: string, preset: string): Promise<string> {
    const normalizedHash = this.normalizeContentHash(contentHash);
    return `/cache/${normalizedHash}/${preset}`;
  }

  async getCacheMetadata(contentHash: string): Promise<Record<string, CacheEntry>> {
    const normalizedHash = this.normalizeContentHash(contentHash);
    const metadataPath = this.getCacheMetadataPath(normalizedHash);

    try {
      const raw = await fs.readFile(metadataPath, 'utf-8');
      const data = JSON.parse(raw);
      if (typeof data !== 'object' || data === null) {
        return {};
      }

      const entries: Record<string, CacheEntry> = {};
      for (const [preset, value] of Object.entries(data as Record<string, any>)) {
        if (!value || typeof value !== 'object') {
          continue;
        }
        if (!isSafePropertyKey(preset) || !isValidPreset(preset)) {
          continue;
        }

        entries[preset] = {
          contentHash: normalizedHash,
          preset,
          path: typeof value.path === 'string' ? value.path : this.getCacheFilePath(normalizedHash, preset),
          size: typeof value.size === 'number' ? value.size : 0,
          mimeType: typeof value.mimeType === 'string' ? value.mimeType : 'application/octet-stream',
          createdAt: value.createdAt ? new Date(value.createdAt) : new Date(0),
          lastAccessed: value.lastAccessed ? new Date(value.lastAccessed) : new Date(0)
        };
      }

      return entries;
    } catch (error: any) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  async cleanupOldCache(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    let deletedCount = 0;
    const now = Date.now();

    const contentDirs = await fs.readdir(this.cachePath);

    for (const contentHash of contentDirs) {
      if (!isValidContentHash(contentHash)) {
        continue;
      }
      const dirPath = path.join(this.cachePath, contentHash);
      assertPathWithin(dirPath, this.cachePath);
      const metadataPath = path.join(dirPath, 'metadata.json');

      try {
        const rawParsed = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        const metadata: Record<string, CacheEntry> = Object.create(null);
        for (const key of Object.keys(rawParsed)) {
          if (isSafePropertyKey(key) && isValidPreset(key)) {
            metadata[key] = rawParsed[key];
          }
        }

        for (const [preset, entry] of Object.entries(metadata)) {
          const lastAccessed = new Date(entry.lastAccessed).getTime();

          if (now - lastAccessed > maxAgeMs) {
            const filePath = path.join(dirPath, `${preset}.jpg`);
            assertPathWithin(filePath, this.cachePath);
            try {
              await fs.unlink(filePath);
              delete metadata[preset];
              deletedCount++;
            } catch {
              // File already deleted
            }
          }
        }

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
