import { S3Client } from '@aws-sdk/client-s3';

export function createS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? 'auto',
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
        }
      : undefined,
    forcePathStyle: false,
  });
}

export function getS3Bucket(): string {
  return process.env.TIGRIS_BUCKET ?? process.env.S3_BUCKET ?? 'pagespace-files';
}
