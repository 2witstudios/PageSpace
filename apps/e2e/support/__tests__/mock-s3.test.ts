import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createMockS3 } from '../mock-s3';

/**
 * The S3 stand-in is driven here by the same SDK, configured the same way, as apps/web's page
 * content store (packages/lib/src/services/page-content-store.ts): an endpoint, a region and
 * static keys, nothing else. If the SDK spoke to it in a way it does not understand, a page
 * create in the browser specs would 500 with nothing in the spec pointing here.
 */

let server: Server;
let client: S3Client;
const Bucket = 'pagespace-e2e';

beforeAll(async () => {
  server = createMockS3();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  client = new S3Client({
    region: 'auto',
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: 'e2e', secretAccessKey: 'e2e-secret' },
  });
});

afterAll(async () => {
  client.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const notFound = async (send: Promise<unknown>): Promise<string | undefined> => {
  try {
    await send;
    return undefined;
  } catch (error) {
    return (error as { name?: string }).name;
  }
};

describe('mock S3', () => {
  it('stores an object and hands the same bytes back', async () => {
    const Key = 'page-content/ab/abc';
    await client.send(new PutObjectCommand({ Bucket, Key, Body: Buffer.from('<p>héllo</p>', 'utf8') }));
    const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
    const got = await client.send(new GetObjectCommand({ Bucket, Key }));
    expect({
      length: head.ContentLength,
      body: Buffer.from((await got.Body?.transformToByteArray()) ?? []).toString('utf8'),
    }).toEqual({ length: Buffer.byteLength('<p>héllo</p>'), body: '<p>héllo</p>' });
  });

  it('answers an object it does not hold the way S3 does', async () => {
    const Key = 'page-content/zz/missing';
    expect([
      await notFound(client.send(new HeadObjectCommand({ Bucket, Key }))),
      await notFound(client.send(new GetObjectCommand({ Bucket, Key }))),
    ]).toEqual(['NotFound', 'NoSuchKey']);
  });

  it('copies an object onto itself, and deletes it', async () => {
    const Key = 'page-content/cd/cde';
    await client.send(new PutObjectCommand({ Bucket, Key, Body: Buffer.from('kept') }));
    await client.send(
      new CopyObjectCommand({ Bucket, Key, CopySource: `${Bucket}/${Key}`, MetadataDirective: 'REPLACE' }),
    );
    const copied = await client.send(new GetObjectCommand({ Bucket, Key }));
    const body = Buffer.from((await copied.Body?.transformToByteArray()) ?? []).toString('utf8');
    await client.send(new DeleteObjectCommand({ Bucket, Key }));
    expect([body, await notFound(client.send(new HeadObjectCommand({ Bucket, Key })))]).toEqual(['kept', 'NotFound']);
  });

  it('keeps buckets apart', async () => {
    const Key = 'page-content/ef/efg';
    await client.send(new PutObjectCommand({ Bucket, Key, Body: Buffer.from('mine') }));
    expect(await notFound(client.send(new GetObjectCommand({ Bucket: 'another-bucket', Key })))).toBe('NoSuchKey');
  });
});

 it('permits browser preflights only from local test origins', async () => {
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/pagespace-e2e/upload`;
  const local = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3209', 'Access-Control-Request-Headers': 'content-type' } });
  expect(local.status).toBe(204);
  expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:3209');
  const foreign = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://foreign.example' } });
  expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
});
