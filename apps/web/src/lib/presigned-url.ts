import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let _client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!_client) {
    _client = new S3Client({
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
  return _client;
}

function getS3Bucket(): string {
  return process.env.TIGRIS_BUCKET ?? process.env.S3_BUCKET ?? 'pagespace-files';
}

export function getPresignedUrlTtl(mimeType: string): number {
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) return 3600;
  return 900;
}

export async function generatePresignedUrl(
  contentHash: string,
  preset?: string,
  ttlSeconds = 3600,
  responseContentDisposition?: string
): Promise<string> {
  const key = preset && preset !== 'original'
    ? `cache/${contentHash}/${preset}`
    : `files/${contentHash}/original`;

  const command = new GetObjectCommand({
    Bucket: getS3Bucket(),
    Key: key,
    ...(responseContentDisposition ? { ResponseContentDisposition: responseContentDisposition } : {}),
  });

  return getSignedUrl(getS3Client(), command, { expiresIn: ttlSeconds });
}
