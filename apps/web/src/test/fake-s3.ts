/**
 * An in-memory S3 for tests that need real object-store behaviour across more
 * than one bucket (uploads, publish, evidence) without a network.
 *
 * Use it by replacing only the client class and keeping the real command
 * classes, so the code under test builds exactly the commands it builds in
 * production:
 *
 *   const fakeS3 = vi.hoisted(() => ({ current: null as null | FakeS3 }));
 *   vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
 *     S3Client: class { send(command: unknown) { return fakeS3.current!.send(command); } },
 *   }));
 */

interface StoredObject {
  body: Uint8Array;
  contentType?: string;
}

interface CommandLike {
  constructor: { name: string };
  input: Record<string, unknown>;
}

function notFound(name: 'NotFound' | 'NoSuchKey'): Error {
  const error = new Error(name) as Error & { $metadata: { httpStatusCode: number } };
  error.name = name;
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function toBytes(body: unknown): Uint8Array {
  // isView, not instanceof: under jsdom a Uint8Array can come from another realm.
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body === undefined || body === null) return new Uint8Array(0);
  throw new Error('FakeS3: unsupported body type');
}

export class FakeS3 {
  readonly buckets = new Map<string, Map<string, StoredObject>>();
  /** Every command sent, in order, as `Name bucket key-or-prefix`. */
  readonly log: string[] = [];
  /** Throw this (once) from the next command whose log line contains the given text. */
  failOn: { match: string; error: Error } | null = null;

  bucket(name: string): Map<string, StoredObject> {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(name, bucket);
    }
    return bucket;
  }

  put(bucket: string, key: string, body: string | Uint8Array, contentType?: string): void {
    this.bucket(bucket).set(key, { body: toBytes(body), contentType });
  }

  keys(bucket: string): string[] {
    return [...this.bucket(bucket).keys()].sort();
  }

  has(bucket: string, key: string): boolean {
    return this.bucket(bucket).has(key);
  }

  async send(command: unknown): Promise<Record<string, unknown>> {
    const { constructor, input } = command as CommandLike;
    const bucketName = String(input.Bucket);
    const bucket = this.bucket(bucketName);
    const key = typeof input.Key === 'string' ? input.Key : undefined;
    const line = `${constructor.name} ${bucketName} ${key ?? String(input.Prefix ?? '')}`;
    this.log.push(line);

    if (this.failOn && line.includes(this.failOn.match)) {
      const { error } = this.failOn;
      this.failOn = null;
      throw error;
    }

    switch (constructor.name) {
      case 'HeadObjectCommand': {
        const object = bucket.get(key!);
        if (!object) throw notFound('NotFound');
        return { ContentLength: object.body.byteLength, ContentType: object.contentType };
      }
      case 'GetObjectCommand': {
        const object = bucket.get(key!);
        if (!object) throw notFound('NoSuchKey');
        return {
          ContentLength: object.body.byteLength,
          ContentType: object.contentType,
          Body: { transformToByteArray: async () => object.body },
        };
      }
      case 'PutObjectCommand': {
        bucket.set(key!, { body: toBytes(input.Body), contentType: input.ContentType as string | undefined });
        return {};
      }
      case 'CopyObjectCommand': {
        const source = String(input.CopySource);
        const slash = source.indexOf('/');
        const object = this.bucket(source.slice(0, slash)).get(decodeURIComponent(source.slice(slash + 1)));
        if (!object) throw notFound('NoSuchKey');
        bucket.set(key!, { ...object });
        return {};
      }
      case 'DeleteObjectCommand': {
        bucket.delete(key!);
        return {};
      }
      case 'DeleteObjectsCommand': {
        const objects = (input.Delete as { Objects: Array<{ Key: string }> }).Objects;
        for (const object of objects) bucket.delete(object.Key);
        return { Deleted: objects };
      }
      case 'ListObjectsV2Command': {
        const prefix = String(input.Prefix ?? '');
        const matching = [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort();
        const limit = typeof input.MaxKeys === 'number' ? input.MaxKeys : 1000;
        return { Contents: matching.slice(0, limit).map((Key) => ({ Key })), IsTruncated: false };
      }
      default:
        throw new Error(`FakeS3: unsupported command ${constructor.name}`);
    }
  }
}
