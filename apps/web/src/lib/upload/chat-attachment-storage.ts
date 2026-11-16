import { createHash } from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';
import { checkObjectExists, putObject } from '@/lib/upload/s3-effects';

const CHAT_ATTACHMENT_PREFIX = 'chat-attachments';
const GET_URL_TTL_SECONDS = 3600;
// Defense-in-depth mirror of MAX_DATA_URL_LENGTH in validate-image-parts.ts: the
// chat route validates inbound data URLs, but this helper must stay safe for any
// future caller that skips route-level validation.
const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export function hashAttachmentBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function buildChatAttachmentKey(contentHash: string): string {
  return `${CHAT_ATTACHMENT_PREFIX}/${contentHash}/original`;
}

/**
 * Write attachment bytes to storage. Does NOT consult the content blocklist:
 * this runs inside the message-save transaction, and every caller screens the
 * whole message first with `screenFilePartsAgainstBlocklist` (message-utils.ts)
 * — one query, before the transaction and before any write.
 */
export async function uploadChatAttachment(
  buffer: Buffer,
  mediaType: string,
): Promise<{ storageKey: string; contentHash: string }> {
  if (buffer.byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error(
      `Chat attachment of ${buffer.byteLength} bytes exceeds the ${MAX_CHAT_ATTACHMENT_BYTES}-byte limit`,
    );
  }
  const contentHash = hashAttachmentBuffer(buffer);
  const storageKey = buildChatAttachmentKey(contentHash);

  const exists = await checkObjectExists(storageKey);
  if (!exists) {
    await putObject(storageKey, buffer, mediaType);
  }

  return { storageKey, contentHash };
}

// The ONLY key shape this module may sign a GET for: exactly what
// buildChatAttachmentKey mints from a sha256. Anchored at both ends, and `\z`
// is spelled `(?![\s\S])` because JS `$` would also match before a trailing
// newline. An echoed URL counts as ours only when its path on our own storage
// host is exactly such a key (ownChatAttachmentKey below).
const CHAT_ATTACHMENT_STORAGE_KEY_EXACT = /^chat-attachments\/[0-9a-f]{64}\/original(?![\s\S])/;

/** Whether `value` is exactly a storage key this module mints — nothing before, nothing after. */
export function isChatAttachmentStorageKey(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ATTACHMENT_STORAGE_KEY_EXACT.test(value);
}

/**
 * Presign a GET for a chat attachment. Throws for any key outside this module's
 * own prefix: the key arrives from a persisted message envelope, which is data a
 * user can influence, and the uploads bucket also holds every tenant's
 * `files/<hash>/original`. The signer is the last point before a URL exists, so
 * the scope check lives here rather than in each caller.
 */
export async function getChatAttachmentUrl(storageKey: string): Promise<string> {
  if (!isChatAttachmentStorageKey(storageKey)) {
    throw new Error('Refusing to sign a URL for a storage key outside the chat-attachments prefix');
  }
  const command = new GetObjectCommand({ Bucket: getS3Bucket(), Key: storageKey });
  return getSignedUrl(getS3Client(), command, { expiresIn: GET_URL_TTL_SECONDS });
}

/**
 * The hosts our own presigned GET URLs are served from, with the path prefix
 * that comes before the key on each: virtual-hosted (`bucket.host/key`) and
 * path-style (`host/bucket/key`). Read at call time from the same settings the
 * S3 client is built from (`@/lib/presigned-url`).
 */
function ownStorageLocations(): Array<{ protocol: string; host: string; pathPrefix: string }> {
  const bucket = getS3Bucket();
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  let protocol = 'https:';
  let hosts: string[];
  if (endpoint) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      return [];
    }
    protocol = parsed.protocol;
    hosts = [parsed.host];
  } else {
    const region = process.env.AWS_REGION;
    if (!region || region === 'auto') return [];
    hosts = [`s3.${region}.amazonaws.com`, ...(region === 'us-east-1' ? ['s3.amazonaws.com'] : [])];
  }
  return hosts.flatMap((host) => [
    { protocol, host: `${bucket}.${host}`, pathPrefix: '/' },
    { protocol, host, pathPrefix: `/${bucket}/` },
  ]);
}

/**
 * The chat-attachment storage key `value` refers to, if it is one of ours:
 * either exactly a key this module mints, or a URL on our own storage host
 * whose path is exactly that key. Any query string is allowed (the presign
 * signature lives there). Everything else is an external reference, even when
 * the key text appears somewhere inside it.
 */
function ownChatAttachmentKey(value: string): string | null {
  if (isChatAttachmentStorageKey(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  for (const location of ownStorageLocations()) {
    if (url.protocol !== location.protocol || url.host !== location.host) continue;
    if (!url.pathname.startsWith(location.pathPrefix)) continue;
    const key = url.pathname.slice(location.pathPrefix.length);
    if (isChatAttachmentStorageKey(key)) return key;
  }
  return null;
}

/**
 * Recover a chat-attachment storage key from a value echoed back by a client
 * (e.g. on resend/regenerate), so it can be re-persisted by its stable key
 * instead of its expiring presigned URL. Only our own key or our own storage
 * URL counts — see ownChatAttachmentKey.
 */
export function parseChatAttachmentStorageKey(url: string): string | null {
  return ownChatAttachmentKey(url);
}

/** The content hash inside one of our chat-attachment keys or storage URLs, if it is one. */
export function parseChatAttachmentContentHash(keyOrUrl: string): string | null {
  const key = ownChatAttachmentKey(keyOrUrl);
  return key ? key.slice(CHAT_ATTACHMENT_PREFIX.length + 1, CHAT_ATTACHMENT_PREFIX.length + 65) : null;
}
