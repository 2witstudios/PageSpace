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

  it('reads an empty object without a Range (S3 answers 416 to a ranged GET of nothing)', async () => {
    const { client: c, send } = client(0, new Uint8Array(0));
    await expect(readS3ObjectBounded(c, 'b', 'k', 100, 1000)).resolves.toEqual({ bytes: new Uint8Array(0), complete: true });
    expect(getInput(send)).toEqual({ Bucket: 'b', Key: 'k' });
  });

  it('reads only the first bytes of an object over the bound, or of unknown size', async () => {
    for (const size of [10_000, undefined]) {
      const { client: c, send } = client(size, new Uint8Array(4096));
      await expect(readS3ObjectBounded(c, 'b', 'k', 100, 1000)).resolves.toMatchObject({ complete: false });
      expect(getInput(send)).toMatchObject({ Range: 'bytes=0-4095' });
    }
  });
});
