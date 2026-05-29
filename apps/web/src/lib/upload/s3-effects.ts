import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';

export async function checkObjectExists(key: string): Promise<boolean> {
  try {
    await getS3Client().send(new HeadObjectCommand({ Bucket: getS3Bucket(), Key: key }));
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'NotFound' || err.name === 'NoSuchKey')) {
      return false;
    }
    // 404 from AWS SDK v3 also surfaces as $metadata.httpStatusCode
    const anyErr = err as { $metadata?: { httpStatusCode?: number } };
    if (anyErr?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

export async function issuePresignedPutUrl(
  key: string,
  contentType: string,
  fileSize: number,
  ttlSeconds: number,
): Promise<string> {
  // Zero-trust: ContentLength is signed into the URL, so S3/Tigris rejects any
  // PUT whose body size differs from the declared fileSize. (content-length-range
  // is a presigned-POST policy condition and is silently ignored on a PUT command.)
  const command = new PutObjectCommand({
    Bucket: getS3Bucket(),
    Key: key,
    ContentType: contentType,
    ContentLength: fileSize,
  });

  return getSignedUrl(getS3Client(), command, { expiresIn: ttlSeconds });
}
