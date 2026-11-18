import { describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { readS3ObjectBounded } from '../s3-objects';

function client(size: number | undefined, body: Uint8Array) {
  const send = vi.fn(async (command: { constructor: { name: string } }) =>
    command.constructor.name === 'HeadObjectCommand' ? { ContentLength: size } : { Body: { transformToByteArray: async () => body } },
  );
  return { client: { send } as unknown as S3Client, send };
}

const getInput = (send: ReturnType<typeof vi.fn>) => (send.mock.calls[1][0] as { input: Record<string, unknown> }).input;

describe('readS3ObjectBounded', () => {
  it('reads a small object with a Range up to the bound, so growth after the HEAD is never buffered', async () => {
    const { client: c, send } = client(3, new Uint8Array([1, 2, 3]));
    await expect(readS3ObjectBounded(c, 'b', 'k', 100, 1000)).resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]), complete: true });
    expect(getInput(send)).toEqual({ Bucket: 'b', Key: 'k', Range: 'bytes=0-100' });
  });

  it('reads an empty object with a Range too, and takes the 416 a ranged GET of nothing gets as empty', async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: 0 };
      throw Object.assign(new Error('InvalidRange'), { name: 'InvalidRange', $metadata: { httpStatusCode: 416 } });
    });
    await expect(readS3ObjectBounded({ send } as unknown as S3Client, 'b', 'k', 100, 1000)).resolves.toEqual({ bytes: new Uint8Array(0), complete: true });
    expect(getInput(send)).toEqual({ Bucket: 'b', Key: 'k', Range: 'bytes=0-100' });
  });

  it('an object empty at the HEAD that grew is read only up to the bound', async () => {
    const { client: c, send } = client(0, new Uint8Array(101));
    await expect(readS3ObjectBounded(c, 'b', 'k', 100, 1000)).resolves.toMatchObject({ complete: false });
    expect(getInput(send)).toEqual({ Bucket: 'b', Key: 'k', Range: 'bytes=0-100' });
  });

  it('a 416 for an object that was not empty at the HEAD is an error, not an empty read', async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: 5 };
      throw Object.assign(new Error('InvalidRange'), { name: 'InvalidRange', $metadata: { httpStatusCode: 416 } });
    });
    await expect(readS3ObjectBounded({ send } as unknown as S3Client, 'b', 'k', 100, 1000)).rejects.toThrow('InvalidRange');
  });

  it('reads only the first bytes of an object over the bound, or of unknown size', async () => {
    for (const size of [10_000, undefined]) {
      const { client: c, send } = client(size, new Uint8Array(4096));
      await expect(readS3ObjectBounded(c, 'b', 'k', 100, 1000)).resolves.toMatchObject({ complete: false });
      expect(getInput(send)).toMatchObject({ Range: 'bytes=0-4095' });
    }
  });
});
