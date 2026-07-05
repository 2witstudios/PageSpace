import { createHash } from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';
import { checkObjectExists, issuePresignedPutUrl } from '@/lib/upload/s3-effects';

const CHAT_ATTACHMENT_PREFIX = 'chat-attachments';
const PUT_URL_TTL_SECONDS = 300;
const GET_URL_TTL_SECONDS = 3600;

export function hashAttachmentBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function buildChatAttachmentKey(contentHash: string): string {
  return `${CHAT_ATTACHMENT_PREFIX}/${contentHash}/original`;
}

export async function uploadChatAttachment(
  buffer: Buffer,
  mediaType: string,
): Promise<{ storageKey: string; contentHash: string }> {
  const contentHash = hashAttachmentBuffer(buffer);
  const storageKey = buildChatAttachmentKey(contentHash);

  const exists = await checkObjectExists(storageKey);
  if (!exists) {
    const putUrl = await issuePresignedPutUrl(storageKey, mediaType, buffer.byteLength, PUT_URL_TTL_SECONDS);
    const response = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mediaType },
      body: buffer,
    });
    if (!response.ok) {
      throw new Error(`Failed to upload chat attachment to S3: ${response.status}`);
    }
  }

  return { storageKey, contentHash };
}

export async function getChatAttachmentUrl(storageKey: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: getS3Bucket(), Key: storageKey });
  return getSignedUrl(getS3Client(), command, { expiresIn: GET_URL_TTL_SECONDS });
}
