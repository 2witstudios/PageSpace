import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { hashWithPrefix } from '../utils/hash-utils';
import {
  compress,
  compressIfNeeded,
  decompressIfNeeded,
  COMPRESSION_THRESHOLD_BYTES,
} from '../utils/compression';
import type { PageContentFormat } from '../content/page-content-format';

const CONTENT_SUBDIR = 'page-content';
const CONTENT_REF_REGEX = /^[a-f0-9]{64}$/i;

const COMPRESSION_MAGIC = 'PSCOMP\0';

export interface WritePageContentOptions {
  compress?: boolean | 'auto';
}

export interface WritePageContentResult {
  ref: string;
  size: number;
  compressed: boolean;
  storedSize: number;
  compressionRatio: number;
}

// --- S3 helpers ---

let _s3: S3Client | null = null;

function s3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: process.env.AWS_REGION ?? 'auto',
      endpoint: process.env.AWS_ENDPOINT_URL_S3,
      credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
    });
  }
  return _s3;
}

function getBucket(): string {
  return process.env.BUCKET_NAME ?? process.env.TIGRIS_BUCKET ?? process.env.S3_BUCKET ?? 'pagespace-files';
}

function assertContentRef(ref: string): void {
  if (!CONTENT_REF_REGEX.test(ref)) {
    throw new Error('Invalid content reference');
  }
}

function getS3Key(ref: string): string {
  assertContentRef(ref);
  return `${CONTENT_SUBDIR}/${ref.slice(0, 2)}/${ref}`;
}

function shouldApplyCompression(
  contentSize: number,
  options?: WritePageContentOptions
): boolean {
  const compressOption = options?.compress ?? 'auto';
  if (compressOption === true) return true;
  if (compressOption === false) return false;
  return contentSize >= COMPRESSION_THRESHOLD_BYTES;
}

export async function writePageContent(
  content: string,
  format: PageContentFormat,
  options?: WritePageContentOptions
): Promise<WritePageContentResult> {
  const ref = hashWithPrefix(format, content);
  const key = getS3Key(ref);
  const bucket = getBucket();

  const originalSize = Buffer.byteLength(content, 'utf8');
  const applyCompression = shouldApplyCompression(originalSize, options);

  let dataToStore: string;
  let compressed = false;
  let storedSize: number;
  let compressionRatio = 1;

  if (applyCompression) {
    const forceCompression = options?.compress === true;
    const compressionResult = forceCompression
      ? { ...compress(content), compressed: true }
      : compressIfNeeded(content);

    if (compressionResult.compressed) {
      dataToStore = COMPRESSION_MAGIC + compressionResult.data;
      compressed = true;
      storedSize = Buffer.byteLength(dataToStore, 'utf8');
      compressionRatio = compressionResult.compressionRatio;
    } else {
      dataToStore = content;
      storedSize = originalSize;
    }
  } else {
    dataToStore = content;
    storedSize = originalSize;
  }

  // Content-addressable: skip upload if already stored
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    await s3().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(dataToStore, 'utf8'),
      ContentType: 'text/plain; charset=utf-8',
    }));
  }

  return { ref, size: originalSize, compressed, storedSize, compressionRatio };
}

export async function readPageContent(ref: string): Promise<string> {
  const key = getS3Key(ref);
  const response = await s3().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
  const bytes = await response.Body!.transformToByteArray();
  const storedContent = Buffer.from(bytes).toString('utf8');

  if (storedContent.startsWith(COMPRESSION_MAGIC)) {
    const compressedData = storedContent.slice(COMPRESSION_MAGIC.length);
    return decompressIfNeeded(compressedData, true);
  }

  return storedContent;
}

export async function isContentCompressed(ref: string): Promise<boolean> {
  const key = getS3Key(ref);
  const response = await s3().send(new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Range: `bytes=0-${COMPRESSION_MAGIC.length - 1}`,
  }));
  const bytes = await response.Body!.transformToByteArray();
  return Buffer.from(bytes).toString('utf8') === COMPRESSION_MAGIC;
}

export async function getContentMetadata(ref: string): Promise<{
  storedSize: number;
  compressed: boolean;
}> {
  const key = getS3Key(ref);
  const [headResponse, compressed] = await Promise.all([
    s3().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key })),
    isContentCompressed(ref),
  ]);

  return {
    storedSize: headResponse.ContentLength ?? 0,
    compressed,
  };
}

export { COMPRESSION_THRESHOLD_BYTES };
