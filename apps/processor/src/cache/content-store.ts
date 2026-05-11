import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { CacheEntry } from '../types';

export const CONTENT_HASH_REGEX = /^[a-f0-9]{64}$/i;

const SAFE_PRESET_REGEX = /^[a-zA-Z0-9_.\-]{1,64}$/;
export function isValidPreset(preset: string): boolean {
  return typeof preset === 'string' && SAFE_PRESET_REGEX.test(preset) && !preset.includes('..');
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafePropertyKey(key: string): boolean {
  return !FORBIDDEN_KEYS.has(key);
}

export function isValidContentHash(contentHash: string): boolean {
  return typeof contentHash === 'string' && CONTENT_HASH_REGEX.test(contentHash);
}

export class InvalidContentHashError extends Error {
  contentHash: string;
  constructor(contentHash: string) {
    super('Invalid content hash format');
    this.name = 'InvalidContentHashError';
    this.contentHash = contentHash;
  }
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

async function streamToBuffer(body: GetObjectCommandOutput['Body']): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isS3NotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return (
    e['name'] === 'NotFound' ||
    e['Code'] === 'NoSuchKey' ||
    e['name'] === 'NoSuchKey' ||
    (e['$metadata'] as Record<string, unknown> | undefined)?.['httpStatusCode'] === 404
  );
}

export class ContentStore {
  private s3: S3Client;
  private bucket: string;

  constructor(s3: S3Client, bucket: string) {
    this.s3 = s3;
    this.bucket = bucket;
  }

  private normalizeContentHash(contentHash: string): string {
    if (!isValidContentHash(contentHash)) {
      throw new InvalidContentHashError(contentHash);
    }
    return contentHash.toLowerCase();
  }

  private originalKey(hash: string): string {
    return `files/${hash}/original`;
  }

  private originalMetaKey(hash: string): string {
    return `files/${hash}/metadata.json`;
  }

  private cacheKey(hash: string, preset: string): string {
    return `cache/${hash}/${preset}`;
  }

  private cacheMetaKey(hash: string): string {
    return `cache/${hash}/metadata.json`;
  }

  async initialize(): Promise<void> {
    // S3 bucket is pre-created — no local dirs to initialize
  }

  private normalizeOriginalMetadata(raw: unknown): OriginalFileMetadata {
    const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const metadata: OriginalFileMetadata = {
      originalName: typeof data.originalName === 'string' ? data.originalName : 'file',
      contentHash: typeof data.contentHash === 'string' ? data.contentHash : '',
      size: typeof data.size === 'number' ? data.size : 0,
      savedAt: typeof data.savedAt === 'string' ? data.savedAt : new Date().toISOString(),
      tenants: Array.isArray(data.tenants)
        ? Array.from(new Set(data.tenants.filter((item: unknown) => typeof item === 'string')))
        : undefined,
      drives: Array.isArray(data.drives)
        ? Array.from(new Set(data.drives.filter((item: unknown) => typeof item === 'string')))
        : undefined,
      uploads: Array.isArray(data.uploads)
        ? data.uploads.map((entry: unknown) => {
            const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
            return {
              tenantId: typeof e.tenantId === 'string' ? e.tenantId : undefined,
              userId: typeof e.userId === 'string' ? e.userId : undefined,
              driveId: typeof e.driveId === 'string' ? e.driveId : undefined,
              service: typeof e.service === 'string' ? e.service : undefined,
              uploadedAt: typeof e.uploadedAt === 'string' ? e.uploadedAt : new Date().toISOString(),
            };
          })
        : undefined,
      lastAccessedAt: typeof data.lastAccessedAt === 'string' ? data.lastAccessedAt : undefined,
    };

    if (!metadata.contentHash) {
      metadata.contentHash = crypto
        .createHash('sha256')
        .update(`${metadata.originalName}:${metadata.size}`)
        .digest('hex');
    }

    return metadata;
  }

  private async writeOriginalMetadata(normalizedHash: string, metadata: OriginalFileMetadata): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.originalMetaKey(normalizedHash),
        Body: JSON.stringify(metadata, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  async getOriginalMetadata(contentHash: string): Promise<OriginalFileMetadata | null> {
    let normalizedHash: string;
    try {
      normalizedHash = this.normalizeContentHash(contentHash);
    } catch (error) {
      if (error instanceof InvalidContentHashError) return null;
      throw error;
    }

    try {
      const resp = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.originalMetaKey(normalizedHash) }),
      );
      const buf = await streamToBuffer(resp.Body);
      return this.normalizeOriginalMetadata(JSON.parse(buf.toString('utf-8')));
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
      savedAt: new Date().toISOString(),
    };

    metadata.tenants = this.mergeUnique(metadata.tenants, options.tenantId);
    metadata.drives = this.mergeUnique(metadata.drives, options.driveId);

    const uploads = metadata.uploads ?? [];
    uploads.push({
      tenantId: options.tenantId,
      userId: options.userId,
      driveId: options.driveId,
      service: options.service,
      uploadedAt: new Date().toISOString(),
    });
    metadata.uploads = uploads;

    await this.writeOriginalMetadata(normalizedHash, metadata);
  }

  private mergeUnique(collection: string[] | undefined, value?: string): string[] | undefined {
    if (!value) return collection;
    const result = new Set(collection ?? []);
    result.add(value);
    return Array.from(result);
  }

  async tenantHasAccess(contentHash: string, tenantId: string | undefined | null): Promise<boolean> {
    if (!tenantId) return false;
    const metadata = await this.getOriginalMetadata(contentHash);
    if (!metadata) return false;
    if (!metadata.tenants || metadata.tenants.length === 0) return true;
    return metadata.tenants.includes(tenantId);
  }

  // Returns S3 key for the cache object — kept for interface compatibility.
  async getCachePath(contentHash: string, preset: string): Promise<string> {
    const normalizedHash = this.normalizeContentHash(contentHash);
    return this.cacheKey(normalizedHash, preset);
  }

  // Returns S3 key for the original — kept for interface compatibility.
  async getOriginalPath(contentHash: string): Promise<string> {
    const normalizedHash = this.normalizeContentHash(contentHash);
    return this.originalKey(normalizedHash);
  }

  async cacheExists(contentHash: string, preset: string): Promise<boolean> {
    let normalizedHash: string;
    try {
      normalizedHash = this.normalizeContentHash(contentHash);
    } catch (error) {
      if (error instanceof InvalidContentHashError) return false;
      throw error;
    }

    if (!isValidPreset(preset)) return false;

    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.cacheKey(normalizedHash, preset) }),
      );
      return true;
    } catch (err) {
      if (isS3NotFound(err)) return false;
      throw err;
    }
  }

  async saveCache(contentHash: string, preset: string, buffer: Buffer, mimeType: string): Promise<CacheEntry> {
    const normalizedHash = this.normalizeContentHash(contentHash);
    const key = this.cacheKey(normalizedHash, preset);

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );

    const entry: CacheEntry = {
      contentHash: normalizedHash,
      preset,
      path: key,
      size: buffer.length,
      mimeType,
      createdAt: new Date(),
      lastAccessed: new Date(),
    };

    // Update cache metadata
    const metaKey = this.cacheMetaKey(normalizedHash);
    let metadata: Record<string, CacheEntry> = Object.create(null);

    try {
      const resp = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: metaKey }));
      const buf = await streamToBuffer(resp.Body);
      const parsed = JSON.parse(buf.toString('utf-8'));
      for (const k of Object.keys(parsed)) {
        if (isSafePropertyKey(k) && isValidPreset(k)) {
          metadata[k] = parsed[k];
        }
      }
    } catch {
      // No existing metadata
    }

    if (isValidPreset(preset)) {
      metadata[preset] = entry;
    }

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: metaKey,
        Body: JSON.stringify(metadata, null, 2),
        ContentType: 'application/json',
      }),
    );

    return entry;
  }

  async getCache(contentHash: string, preset: string): Promise<Buffer | null> {
    let normalizedHash: string;
    try {
      normalizedHash = this.normalizeContentHash(contentHash);
    } catch (error) {
      if (error instanceof InvalidContentHashError) return null;
      throw error;
    }

    if (!isValidPreset(preset)) return null;

    try {
      const resp = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.cacheKey(normalizedHash, preset) }),
      );
      return streamToBuffer(resp.Body);
    } catch {
      return null;
    }
  }

  async saveOriginal(
    buffer: Buffer,
    originalName: string,
    options: SaveOriginalOptions = {},
  ): Promise<{ contentHash: string; path: string }> {
    const rawHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const normalizedHash = this.normalizeContentHash(rawHash);
    const key = this.originalKey(normalizedHash);

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
      }),
    );

    const metadata: OriginalFileMetadata = {
      originalName,
      contentHash: normalizedHash,
      size: buffer.length,
      savedAt: new Date().toISOString(),
    };

    await this.writeOriginalMetadata(normalizedHash, metadata);
    await this.appendUploadMetadata(normalizedHash, options);

    return { contentHash: normalizedHash, path: key };
  }

  async saveOriginalFromFile(
    tempFilePath: string,
    originalName: string,
    precomputedHash?: string,
    options: SaveOriginalOptions = {},
  ): Promise<{ contentHash: string; path: string }> {
    const rawHash = precomputedHash ?? (await this.hashFile(tempFilePath));
    const normalizedHash = this.normalizeContentHash(rawHash);
    const key = this.originalKey(normalizedHash);

    const fileStream = createReadStream(tempFilePath);
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: fileStream,
      },
    });
    await upload.done();

    const fileStat = await stat(tempFilePath);

    const metadata: OriginalFileMetadata = {
      originalName,
      contentHash: normalizedHash,
      size: fileStat.size,
      savedAt: new Date().toISOString(),
    };

    await this.writeOriginalMetadata(normalizedHash, metadata);
    await this.appendUploadMetadata(normalizedHash, options);

    return { contentHash: normalizedHash, path: key };
  }

  async originalExists(contentHash: string): Promise<boolean> {
    try {
      const normalizedHash = this.normalizeContentHash(contentHash);
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.originalKey(normalizedHash) }),
      );
      return true;
    } catch (err) {
      if (isS3NotFound(err)) return false;
      if (err instanceof InvalidContentHashError) return false;
      throw err;
    }
  }

  private async hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async getOriginal(contentHash: string): Promise<Buffer | null> {
    let normalizedHash: string;
    try {
      normalizedHash = this.normalizeContentHash(contentHash);
    } catch (error) {
      if (error instanceof InvalidContentHashError) return null;
      throw error;
    }

    try {
      const resp = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.originalKey(normalizedHash) }),
      );
      return streamToBuffer(resp.Body);
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

    try {
      const resp = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.cacheMetaKey(normalizedHash) }),
      );
      const buf = await streamToBuffer(resp.Body);
      const data = JSON.parse(buf.toString('utf-8'));

      if (typeof data !== 'object' || data === null) return {};

      const entries: Record<string, CacheEntry> = {};
      for (const [preset, value] of Object.entries(data as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        if (!isSafePropertyKey(preset) || !isValidPreset(preset)) continue;

        const entry = value as Record<string, unknown>;
        entries[preset] = {
          contentHash: normalizedHash,
          preset,
          path: typeof entry.path === 'string' ? entry.path : this.cacheKey(normalizedHash, preset),
          size: typeof entry.size === 'number' ? entry.size : 0,
          mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : 'application/octet-stream',
          createdAt: entry.createdAt ? new Date(entry.createdAt as string) : new Date(0),
          lastAccessed: entry.lastAccessed ? new Date(entry.lastAccessed as string) : new Date(0),
        };
      }

      return entries;
    } catch (err) {
      if (isS3NotFound(err)) return {};
      throw err;
    }
  }

  async deleteOriginal(contentHash: string): Promise<boolean> {
    let normalizedHash: string;
    try {
      normalizedHash = this.normalizeContentHash(contentHash);
    } catch (error) {
      if (error instanceof InvalidContentHashError) return false;
      throw error;
    }

    try {
      await Promise.all([
        this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.originalKey(normalizedHash) })),
        this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.originalMetaKey(normalizedHash) })),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async deleteCache(contentHash: string): Promise<boolean> {
    let normalizedHash: string;
    try {
      normalizedHash = this.normalizeContentHash(contentHash);
    } catch (error) {
      if (error instanceof InvalidContentHashError) return false;
      throw error;
    }

    try {
      const listResp = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `cache/${normalizedHash}/` }),
      );

      const objects = listResp.Contents ?? [];
      if (objects.length === 0) return true;

      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects.map((obj) => ({ Key: obj.Key! })) },
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async deleteOriginalAndCache(contentHash: string): Promise<{ originalDeleted: boolean; cacheDeleted: boolean }> {
    const [originalDeleted, cacheDeleted] = await Promise.all([
      this.deleteOriginal(contentHash),
      this.deleteCache(contentHash),
    ]);
    return { originalDeleted, cacheDeleted };
  }

  async cleanupOldCache(_maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    // S3 lifecycle rules handle TTL — no-op here
    return 0;
  }
}
