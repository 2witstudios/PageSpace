import { Readable } from 'stream';
import { createReadStream, createWriteStream } from 'fs';
import { stat, mkdir, readFile } from 'fs/promises';
import { pipeline } from 'stream/promises';
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
import { maybeEncryptBuffer, maybeDecryptBuffer } from './envelope-crypto';

/**
 * At-rest encryption policy for stored objects (GDPR #966 / #973).
 *
 * `enabled` gates encryption of browser-served objects (originals + binary
 * cache presets) — default OFF because those are delivered to the browser via
 * presigned S3 URLs that cannot decrypt. Server-side-only text caches are
 * encrypted whenever a key is present regardless of `enabled` (see
 * TEXT_PRESETS), since they are consumed/served server-side and never presigned.
 */
export interface ContentEncryptionConfig {
  enabled: boolean;
  masterKey: string;
}

/** Cache presets consumed/served server-side only — safe to always encrypt. */
const TEXT_PRESETS = new Set(['extracted-text.txt', 'ocr-text.txt']);

export function resolveEncryptionConfigFromEnv(): ContentEncryptionConfig {
  return {
    enabled: process.env.FILE_ENCRYPTION_ENABLED === 'true',
    masterKey: process.env.ENCRYPTION_KEY ?? '',
  };
}

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

const METADATA_MAX_BYTES = 50 * 1024 * 1024;      // 50 MB — JSON metadata & cached variants
const ORIGINAL_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB — ceiling for original file reads

async function streamToBuffer(
  body: GetObjectCommandOutput['Body'],
  maxBytes = METADATA_MAX_BYTES,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`S3 object exceeds maximum buffer size of ${maxBytes} bytes`);
    }
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
  private encryption: ContentEncryptionConfig;

  constructor(s3: S3Client, bucket: string, encryption: ContentEncryptionConfig = resolveEncryptionConfigFromEnv()) {
    this.s3 = s3;
    this.bucket = bucket;
    this.encryption = encryption;
  }

  private hasKey(): boolean {
    return this.encryption.masterKey.length > 0;
  }

  /** Encrypt original bytes only when the file-encryption flag is on. */
  private encryptOriginalBytes(buffer: Buffer): Buffer {
    return maybeEncryptBuffer(buffer, {
      enabled: this.encryption.enabled && this.hasKey(),
      masterKey: this.encryption.masterKey,
    });
  }

  /**
   * Encrypt cache bytes. Server-side text presets are always encrypted when a
   * key exists; browser-served binary presets only when the flag is on.
   */
  private encryptCacheBytes(preset: string, buffer: Buffer): Buffer {
    const alwaysEncrypt = TEXT_PRESETS.has(preset);
    const enabled = (this.encryption.enabled || alwaysEncrypt) && this.hasKey();
    return maybeEncryptBuffer(buffer, { enabled, masterKey: this.encryption.masterKey });
  }

  /** Transparently decrypt envelope bytes; legacy plaintext passes through. */
  private decryptBytes(buffer: Buffer): Buffer {
    if (!this.hasKey()) return buffer;
    return maybeDecryptBuffer(buffer, { masterKey: this.encryption.masterKey });
  }

  /** Whether original reads must buffer-and-decrypt rather than raw-stream. */
  private originalsEncrypted(): boolean {
    return this.encryption.enabled && this.hasKey();
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
        Body: this.encryptCacheBytes(preset, buffer),
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
      return this.decryptBytes(await streamToBuffer(resp.Body));
    } catch {
      return null;
    }
  }

  async saveOriginal(
    buffer: Buffer,
    originalName: string,
    options: SaveOriginalOptions = {},
  ): Promise<{ contentHash: string; path: string }> {
    // Hash is always computed over the PLAINTEXT bytes so the content-address
    // (dedup key + integrity check) is stable whether or not the stored object
    // is encrypted at rest.
    const rawHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const normalizedHash = this.normalizeContentHash(rawHash);
    const key = this.originalKey(normalizedHash);

    // ContentType omitted: presigned-URL delivery overrides via ResponseContentType.
    // If a direct-serve path is ever added, add a mimeType param here.
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: this.encryptOriginalBytes(buffer),
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

    // ContentType omitted: presigned-URL delivery overrides via ResponseContentType.
    // If a direct-serve path is ever added, add a mimeType param here.
    let size: number;
    if (this.originalsEncrypted()) {
      // Encryption buffers the (content-addressed, size-capped) file to wrap it
      // in an envelope; streaming GCM is avoided for format simplicity. Size is
      // taken from the single read — no separate stat() (avoids a TOCTOU race).
      const plain = await readFile(tempFilePath);
      size = plain.length;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: this.encryptOriginalBytes(plain),
        }),
      );
    } else {
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
      size = (await stat(tempFilePath)).size;
    }

    const metadata: OriginalFileMetadata = {
      originalName,
      contentHash: normalizedHash,
      size,
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

  /**
   * HEAD-probe an original object and return its size in bytes, or `null` if it
   * is definitively absent (not-found) or the hash is malformed. Unlike
   * {@link getOriginal} — which swallows every error into `null` — this RE-THROWS
   * genuine infrastructure failures (network, auth, 5xx) so callers can tell a
   * transient outage apart from an absent object. Used by the verify endpoint to
   * gate the synchronous download on size without first buffering the bytes.
   */
  async headOriginalSize(contentHash: string): Promise<number | null> {
    let normalizedHash: string;
    try {
      normalizedHash = this.normalizeContentHash(contentHash);
    } catch (error) {
      if (error instanceof InvalidContentHashError) return null;
      throw error;
    }

    try {
      const resp = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.originalKey(normalizedHash) }),
      );
      return typeof resp.ContentLength === 'number' ? resp.ContentLength : null;
    } catch (err) {
      if (isS3NotFound(err)) return null;
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

  // Loads the entire file into memory (up to ORIGINAL_MAX_BYTES = 2 GB).
  // Avoid for large files; use streamOriginalToFile instead.
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
      return this.decryptBytes(await streamToBuffer(resp.Body, ORIGINAL_MAX_BYTES));
    } catch {
      return null;
    }
  }

  async streamOriginalToFile(contentHash: string, destPath: string): Promise<void> {
    const normalizedHash = this.normalizeContentHash(contentHash);
    await mkdir(path.dirname(destPath), { recursive: true });

    // Whenever a key is configured, buffer-and-decrypt (objects are content-
    // addressed and size-capped) so previously-enveloped originals decrypt
    // correctly EVEN IF FILE_ENCRYPTION_ENABLED was later turned off — otherwise
    // the raw PSE1 envelope would be streamed to disk. getOriginal() decrypts
    // envelopes and passes legacy plaintext through. Only raw-stream when no key
    // exists (nothing could be encrypted).
    if (this.hasKey()) {
      const buf = await this.getOriginal(normalizedHash);
      if (!buf) throw new Error(`File not found in S3: ${contentHash}`);
      await pipeline(Readable.from(buf), createWriteStream(destPath));
      return;
    }

    const resp = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.originalKey(normalizedHash) }),
    );
    if (!resp.Body) throw new Error(`File not found in S3: ${contentHash}`);
    await pipeline(Readable.from(resp.Body as AsyncIterable<Uint8Array>), createWriteStream(destPath));
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
          Delete: { Objects: objects.flatMap((obj) => obj.Key ? [{ Key: obj.Key }] : []) },
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
