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

/**
 * Build a minimal ELF64 executable fixture that Magika can classify as `elf`.
 * The ELF header itself is only 64 bytes, but Magika's classifier looks at the
 * first+last block of the file and expects a realistic distribution of bytes
 * (load commands, program headers, text section contents). A header followed
 * by 4KB of zero padding classifies as `iso` or `bin` because zero runs are
 * the hallmark of sparse disk images, not executables.
 *
 * So we do two things:
 *  - Emit a correct ELF64 header (e_ident + type/machine/version/entry/phoff/
 *    shoff/flags/ehsize/phentsize/phnum/shentsize/shnum/shstrndx).
 *  - Follow the header with a realistic-looking program payload: one PT_LOAD
 *    program header, then pseudo-random bytes that simulate compiled machine
 *    code. Random bytes have the same byte-frequency distribution as real
 *    x86-64 text sections from the classifier's point of view.
 */
function makeElf64(): Buffer {
  const payloadSize = 8192;
  const buf = Buffer.alloc(64 + 56 + payloadSize);
  let off = 0;

  // e_ident
  buf.writeUInt8(0x7f, off++); // EI_MAG0
  buf.writeUInt8(0x45, off++); // 'E'
  buf.writeUInt8(0x4c, off++); // 'L'
  buf.writeUInt8(0x46, off++); // 'F'
  buf.writeUInt8(2, off++);    // EI_CLASS = ELFCLASS64
  buf.writeUInt8(1, off++);    // EI_DATA  = ELFDATA2LSB
  buf.writeUInt8(1, off++);    // EI_VERSION
  buf.writeUInt8(0, off++);    // EI_OSABI = System V
  buf.writeUInt8(0, off++);    // EI_ABIVERSION
  // 7 bytes EI_PAD — already zero
  off = 16;

  buf.writeUInt16LE(2, off); off += 2;       // e_type = ET_EXEC
  buf.writeUInt16LE(0x3e, off); off += 2;    // e_machine = EM_X86_64
  buf.writeUInt32LE(1, off); off += 4;       // e_version
  buf.writeBigUInt64LE(0x400078n, off); off += 8; // e_entry
  buf.writeBigUInt64LE(64n, off); off += 8;  // e_phoff — program headers right after ehdr
  buf.writeBigUInt64LE(0n, off); off += 8;   // e_shoff
  buf.writeUInt32LE(0, off); off += 4;       // e_flags
  buf.writeUInt16LE(64, off); off += 2;      // e_ehsize
  buf.writeUInt16LE(56, off); off += 2;      // e_phentsize
  buf.writeUInt16LE(1, off); off += 2;       // e_phnum
  buf.writeUInt16LE(0, off); off += 2;       // e_shentsize
  buf.writeUInt16LE(0, off); off += 2;       // e_shnum
  buf.writeUInt16LE(0, off); off += 2;       // e_shstrndx

  // Program header (PT_LOAD)
  off = 64;
  buf.writeUInt32LE(1, off); off += 4;               // p_type = PT_LOAD
  buf.writeUInt32LE(5, off); off += 4;               // p_flags = PF_R|PF_X
  buf.writeBigUInt64LE(0n, off); off += 8;           // p_offset
  buf.writeBigUInt64LE(0x400000n, off); off += 8;    // p_vaddr
  buf.writeBigUInt64LE(0x400000n, off); off += 8;    // p_paddr
  buf.writeBigUInt64LE(BigInt(64 + 56 + payloadSize), off); off += 8; // p_filesz
  buf.writeBigUInt64LE(BigInt(64 + 56 + payloadSize), off); off += 8; // p_memsz
  buf.writeBigUInt64LE(0x200000n, off); off += 8;    // p_align

  // Fake text section — deterministic pseudo-random bytes so tests are stable.
  // Using a simple LCG keyed off ELF so the byte distribution roughly matches
  // compiled machine code rather than zero padding.
  let state = 0x5eedbee5;
  for (let i = 0; i < payloadSize; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buf.writeUInt8(state & 0xff, 64 + 56 + i);
  }

  return buf;
}

const fixtures = {
  png: path.join(FIXTURE_DIR, 'sample.png'),
  python: path.join(FIXTURE_DIR, 'sample.py'),
  pdf: path.join(FIXTURE_DIR, 'sample.pdf'),
  elf: path.join(FIXTURE_DIR, 'sample-elf.bin'),
};

beforeAll(async () => {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  await fs.writeFile(fixtures.png, PNG_BYTES);
  await fs.writeFile(fixtures.python, PYTHON_SOURCE, 'utf8');
  await fs.writeFile(fixtures.pdf, PDF_BYTES);
  await fs.writeFile(fixtures.elf, makeElf64());
});

afterAll(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  __resetContentDetectorForTests();
  vi.restoreAllMocks();
});

describe('detectContentType', () => {
  it('given real fixtures on disk, classifies each as its true type via the loaded magika model', async () => {
    const [png, py, pdf, elf] = await Promise.all([
      detectContentType(fixtures.png),
      detectContentType(fixtures.python),
      detectContentType(fixtures.pdf),
      detectContentType(fixtures.elf),
    ]);

    for (const result of [png, py, pdf, elf]) {
      expect(result.source).toBe('magika');
    }

    // Each fixture must classify as its canonical label — this is what proves
    // the DENIED_LABELS denylist would actually catch a renamed executable at
    // upload time. If we loosen these expectations we lose the load-bearing
    // evidence that Magika is working.
    expect(png.label).toBe('png');
    expect(py.label).toBe('python');
    expect(pdf.label).toBe('pdf');
    expect(elf.label).toBe('elf');
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
