import { createHash } from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';
import { checkObjectExists, putObject } from '@/lib/upload/s3-effects';

const CHAT_ATTACHMENT_PREFIX = 'chat-attachments';
const GET_URL_TTL_SECONDS = 3600;
// Matches the storage key this module mints in buildChatAttachmentKey, wherever
// it appears in a URL path — virtual-hosted (bucket.host/key) and path-style
// (host/bucket/key) presigned URLs both put the key verbatim in the pathname.
const CHAT_ATTACHMENT_KEY_PATTERN = /(chat-attachments\/[0-9a-f]{64}\/original)/;
// Defense-in-depth mirror of MAX_DATA_URL_LENGTH in validate-image-parts.ts: the
// chat route validates inbound data URLs, but this helper must stay safe for any
// future caller that skips route-level validation.
const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024;

function hashAttachmentBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function buildChatAttachmentKey(contentHash: string): string {
  return `${CHAT_ATTACHMENT_PREFIX}/${contentHash}/original`;
}

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

export async function getChatAttachmentUrl(storageKey: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: getS3Bucket(), Key: storageKey });
  return getSignedUrl(getS3Client(), command, { expiresIn: GET_URL_TTL_SECONDS });
}

/**
 * Recover a chat-attachment storage key from a URL, if it is one of our own
 * presigned GET URLs for this prefix. Used to recognize an attachment echoed
 * back by a client (e.g. on resend/regenerate) so it can be re-persisted by
 * its stable storageKey instead of its expiring presigned URL.
 */
export function parseChatAttachmentStorageKey(url: string): string | null {
  const match = CHAT_ATTACHMENT_KEY_PATTERN.exec(url);
  return match ? match[1] : null;
}
