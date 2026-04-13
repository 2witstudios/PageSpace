import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

import {
  detectContentType,
  FALLBACK_DETECTION,
  __resetContentDetectorForTests,
} from '../content-detector';

const FIXTURE_DIR = path.join(os.tmpdir(), `pagespace-magika-${process.pid}`);

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0x99, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x5b, 0x7e, 0x2b,
  0x1c, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const PYTHON_SOURCE = `#!/usr/bin/env python3
"""A sample module for content detection tests."""

import os
import sys


def main() -> int:
    print("hello, world")
    for key in sorted(os.environ):
        if key.startswith("PAGE"):
            print(key)
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n' +
    '0000000010 00000 n \n0000000060 00000 n \n0000000110 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n180\n%%EOF\n',
  'binary',
);

function makeMachO(): Buffer {
  const buf = Buffer.alloc(4096);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x01000007, 4);
  buf.writeUInt32LE(0x00000003, 8);
  buf.writeUInt32LE(0x00000002, 12);
  return buf;
}

const fixtures = {
  png: path.join(FIXTURE_DIR, 'sample.png'),
  python: path.join(FIXTURE_DIR, 'sample.py'),
  pdf: path.join(FIXTURE_DIR, 'sample.pdf'),
  macho: path.join(FIXTURE_DIR, 'sample-macho.bin'),
};

beforeAll(async () => {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  await fs.writeFile(fixtures.png, PNG_BYTES);
  await fs.writeFile(fixtures.python, PYTHON_SOURCE, 'utf8');
  await fs.writeFile(fixtures.pdf, PDF_BYTES);
  await fs.writeFile(fixtures.macho, makeMachO());
});

afterAll(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  __resetContentDetectorForTests();
  vi.restoreAllMocks();
});

describe('detectContentType', () => {
  it('given real fixtures on disk, classifies via the loaded magika model', async () => {
    const [png, py, pdf, macho] = await Promise.all([
      detectContentType(fixtures.png),
      detectContentType(fixtures.python),
      detectContentType(fixtures.pdf),
      detectContentType(fixtures.macho),
    ]);

    for (const result of [png, py, pdf, macho]) {
      expect(result.source).toBe('magika');
      expect(typeof result.label).toBe('string');
      expect(result.label.length).toBeGreaterThan(0);
      expect(typeof result.mimeType).toBe('string');
      expect(result.mimeType.length).toBeGreaterThan(0);
    }

    expect(png.label).toBe('png');
    expect(py.label).toBe('python');
    expect(pdf.label).toBe('pdf');
  }, 15000);

  it('given a missing file path, returns the fallback shape without throwing', async () => {
    const result = await detectContentType(
      path.join(FIXTURE_DIR, 'does-not-exist-anywhere.xyz'),
    );
    expect(result).toEqual(FALLBACK_DETECTION);
  });

  it('given two sequential detections, reuses a single magika instance', async () => {
    const createSpy = await spyOnMagikaCreate();

    await detectContentType(fixtures.python);
    await detectContentType(fixtures.pdf);

    expect(createSpy).toHaveBeenCalledTimes(1);
  }, 15000);

  it('given concurrent detections during cold start, reuses a single magika instance', async () => {
    const createSpy = await spyOnMagikaCreate();

    await Promise.all([
      detectContentType(fixtures.png),
      detectContentType(fixtures.pdf),
      detectContentType(fixtures.python),
    ]);

    expect(createSpy).toHaveBeenCalledTimes(1);
  }, 15000);

  it('given a magika init failure, falls back without permanently poisoning the cache', async () => {
    const mod = await import('magika/node');
    const createSpy = vi
      .spyOn(mod.MagikaNode, 'create')
      .mockRejectedValueOnce(new Error('boom'));

    const failed = await detectContentType(fixtures.python);
    expect(failed.source).toBe('fallback');
    expect(createSpy).toHaveBeenCalledTimes(1);

    // The cache should not be permanently poisoned. The reset helper exists
    // so tests don't have to wait for the production 60s init backoff window
    // to elapse — it models what time-based recovery does in production.
    __resetContentDetectorForTests();
    createSpy.mockRestore();

    const recovered = await detectContentType(fixtures.python);
    expect(recovered.source).toBe('magika');
    expect(recovered.label).toBe('python');
  }, 15000);
});

async function spyOnMagikaCreate() {
  const mod = await import('magika/node');
  return vi.spyOn(mod.MagikaNode, 'create');
}
