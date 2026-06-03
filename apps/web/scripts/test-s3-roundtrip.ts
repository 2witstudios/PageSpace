/**
 * Standalone Tigris/S3 round-trip check for the direct-to-S3 upload path.
 *
 * Exercises the parts the unit tests deliberately mock out:
 *   - real presigned-PUT signing
 *   - a real browser-style PUT to the bucket (proves the URL + Content-Type)
 *   - signed ContentLength enforcement  (zero-trust: wrong size must be rejected)
 *   - CORS preflight                    (go-live step #1)
 *   - object actually landed            (HeadObject)
 * Then it deletes the test object.
 *
 * The S3 client config and the presigned PUT below are kept identical to the
 * production code they mirror:
 *   - apps/web/src/lib/presigned-url.ts   (getS3Client / getS3Bucket)
 *   - apps/web/src/lib/upload/s3-effects.ts (issuePresignedPutUrl / checkObjectExists)
 *   - packages/lib/src/services/upload-validation.ts (buildS3Key)
 * They're inlined (not imported) because the repo's `@/` tsconfig alias does not
 * resolve under bare `bun`. If the production signing changes, update this too.
 *
 * It does NOT build or boot the web/processor apps and never touches Postgres
 * or pg-boss. It DOES write + delete one real object in your Tigris bucket.
 *
 * Run from the repo root:
 *   AWS_ENDPOINT_URL_S3=https://t3.storage.dev \
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... BUCKET_NAME=... \
 *   bun apps/web/scripts/test-s3-roundtrip.ts
 *
 * Optional:
 *   --file <path>     upload a real file instead of the built-in 1x1 PNG
 *   --origin <url>    Origin to use for the CORS preflight (default https://app.pagespace.ai)
 *   --keep            don't delete the object afterwards
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ---- mirror of presigned-url.ts ---------------------------------------------
function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? 'auto', // 'auto' is correct for Tigris
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
}
function getS3Bucket(): string {
  return (
    process.env.BUCKET_NAME ??
    process.env.TIGRIS_BUCKET ??
    process.env.S3_BUCKET ??
    'pagespace-files'
  );
}
// ---- mirror of s3-effects.ts -------------------------------------------------
function issuePresignedPutUrl(
  client: S3Client,
  bucket: string,
  key: string,
  contentType: string,
  fileSize: number,
  ttlSeconds: number,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: fileSize, // signed into the URL => bucket rejects size mismatch
  });
  return getSignedUrl(client, command, { expiresIn: ttlSeconds });
}
async function checkObjectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'NotFound' || err.name === 'NoSuchKey')) return false;
    const anyErr = err as { $metadata?: { httpStatusCode?: number } };
    if (anyErr?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}
// ---- mirror of upload-validation.ts -----------------------------------------
const buildS3Key = (hash: string): string => `files/${hash}/original`;

// ---- tiny arg parsing -------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const filePath = arg('--file');
const origin = arg('--origin') ?? 'https://app.pagespace.ai';
const keep = argv.includes('--keep');

// 1x1 transparent PNG — valid bytes so Magika classifies it as image/png (allowed).
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let pass = 0;
let fail = 0;
const ok = (msg: string) => { pass++; console.log(`  ✓ ${msg}`); };
const bad = (msg: string) => { fail++; console.log(`  ✗ ${msg}`); };

async function main() {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  if (!endpoint) {
    console.error('AWS_ENDPOINT_URL_S3 is not set. Point it at your Tigris endpoint (e.g. https://t3.storage.dev).');
    process.exit(2);
  }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set.');
    process.exit(2);
  }

  const client = getS3Client();
  const bucket = getS3Bucket();

  const bytes = filePath ? readFileSync(filePath) : ONE_PX_PNG;
  const contentType = filePath ? 'application/octet-stream' : 'image/png';
  const fileSize = bytes.byteLength;
  const hash = createHash('sha256').update(bytes).digest('hex'); // lowercase hex, matches server
  const key = buildS3Key(hash);

  console.log('Tigris round-trip check');
  console.log(`  endpoint : ${endpoint}`);
  console.log(`  bucket   : ${bucket}`);
  console.log(`  region   : ${process.env.AWS_REGION ?? 'auto'}`);
  console.log(`  origin   : ${origin}`);
  console.log(`  object   : ${key}  (${fileSize} bytes, ${contentType})`);
  console.log('');

  // 1. real presigned-PUT signing
  const url = await issuePresignedPutUrl(client, bucket, key, contentType, fileSize, 900);
  ok('signed a presigned PUT (ttl 900s)');
  const objectUrl = url.split('?')[0];

  // 2. CORS preflight (go-live step #1)
  try {
    const pre = await fetch(objectUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const allow = pre.headers.get('access-control-allow-origin');
    const allowMethods = pre.headers.get('access-control-allow-methods') ?? '';
    if (allow && (allow === '*' || allow === origin)) {
      ok(`CORS preflight allows ${origin} (allow-origin=${allow}, methods=${allowMethods || 'n/a'})`);
    } else {
      bad(`CORS preflight did NOT allow ${origin} (status ${pre.status}, allow-origin=${allow ?? 'none'}). Apply TIGRIS_CORS.md for this bucket.`);
    }
  } catch (e) {
    bad(`CORS preflight request errored: ${(e as Error).message}`);
  }

  // 3. the real PUT (correct size)
  try {
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, Origin: origin },
      body: bytes,
    });
    if (put.ok) {
      ok(`PUT succeeded (${put.status})`);
    } else {
      bad(`PUT failed (${put.status}): ${(await put.text()).slice(0, 200)}`);
    }
  } catch (e) {
    bad(`PUT request errored: ${(e as Error).message}`);
  }

  // 4. signed ContentLength enforcement (zero-trust)
  try {
    const wrongUrl = await issuePresignedPutUrl(client, bucket, key, contentType, fileSize + 1, 900);
    const wrongPut = await fetch(wrongUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes, // body is fileSize, URL signed for fileSize+1 -> must be rejected
    });
    if (!wrongPut.ok) {
      ok(`size-mismatch PUT rejected as expected (${wrongPut.status}) — ContentLength is enforced`);
    } else {
      bad(`size-mismatch PUT was ACCEPTED (${wrongPut.status}) — ContentLength is NOT being enforced`);
    }
  } catch (e) {
    bad(`size-mismatch PUT request errored: ${(e as Error).message}`);
  }

  // 5. object actually landed (HeadObject)
  try {
    const exists = await checkObjectExists(client, bucket, key);
    exists ? ok('HeadObject confirms the object landed') : bad('HeadObject says the object is missing');
  } catch (e) {
    bad(`HeadObject errored: ${(e as Error).message}`);
  }

  // cleanup
  if (!keep) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      console.log(`\n  cleaned up ${key}`);
    } catch (e) {
      console.log(`\n  (cleanup failed, delete ${key} manually: ${(e as Error).message})`);
    }
  } else {
    console.log(`\n  --keep set; left ${key} in the bucket`);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nRound-trip crashed:', e);
  process.exit(1);
});
