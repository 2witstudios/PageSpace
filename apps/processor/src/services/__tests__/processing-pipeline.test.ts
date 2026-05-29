import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

import {
  verifyContentHash,
  isAllowedContentType,
  detectContentType,
  type MagikaResult,
} from '../processing-pipeline';

// --- Fixtures (real bytes so detection runs against the loaded Magika model) ---

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

// Minimal ELF64 executable that Magika classifies as `elf` (header + realistic payload).
function makeElf64(): Buffer {
  const payloadSize = 8192;
  const buf = Buffer.alloc(64 + 56 + payloadSize);
  let off = 0;
  buf.writeUInt8(0x7f, off++);
  buf.writeUInt8(0x45, off++);
  buf.writeUInt8(0x4c, off++);
  buf.writeUInt8(0x46, off++);
  buf.writeUInt8(2, off++);
  buf.writeUInt8(1, off++);
  buf.writeUInt8(1, off++);
  buf.writeUInt8(0, off++);
  buf.writeUInt8(0, off++);
  off = 16;
  buf.writeUInt16LE(2, off); off += 2;
  buf.writeUInt16LE(0x3e, off); off += 2;
  buf.writeUInt32LE(1, off); off += 4;
  buf.writeBigUInt64LE(0x400078n, off); off += 8;
  buf.writeBigUInt64LE(64n, off); off += 8;
  buf.writeBigUInt64LE(0n, off); off += 8;
  buf.writeUInt32LE(0, off); off += 4;
  buf.writeUInt16LE(64, off); off += 2;
  buf.writeUInt16LE(56, off); off += 2;
  buf.writeUInt16LE(1, off); off += 2;
  buf.writeUInt16LE(0, off); off += 2;
  buf.writeUInt16LE(0, off); off += 2;
  buf.writeUInt16LE(0, off); off += 2;
  off = 64;
  buf.writeUInt32LE(1, off); off += 4;
  buf.writeUInt32LE(5, off); off += 4;
  buf.writeBigUInt64LE(0n, off); off += 8;
  buf.writeBigUInt64LE(0x400000n, off); off += 8;
  buf.writeBigUInt64LE(0x400000n, off); off += 8;
  buf.writeBigUInt64LE(BigInt(64 + 56 + payloadSize), off); off += 8;
  buf.writeBigUInt64LE(BigInt(64 + 56 + payloadSize), off); off += 8;
  buf.writeBigUInt64LE(0x200000n, off); off += 8;
  let state = 0x5eedbee5;
  for (let i = 0; i < payloadSize; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buf.writeUInt8(state & 0xff, 64 + 56 + i);
  }
  return buf;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeResult(label: string, mimeType = 'application/octet-stream'): MagikaResult {
  return { label, mimeType, score: 0.99, source: 'magika' };
}

describe('verifyContentHash', () => {
  it('given bytes and their true SHA-256, returns true', () => {
    expect(verifyContentHash(PNG_BYTES, sha256(PNG_BYTES))).toBe(true);
  });

  it('given bytes and a mismatched hash, returns false — never trusts the client value', () => {
    expect(verifyContentHash(PNG_BYTES, sha256(PDF_BYTES))).toBe(false);
  });

  it('given an uppercase expected hash, still matches the lowercase digest', () => {
    expect(verifyContentHash(PNG_BYTES, sha256(PNG_BYTES).toUpperCase())).toBe(true);
  });

  it('given a malformed expected hash, returns false rather than throwing', () => {
    expect(verifyContentHash(PNG_BYTES, 'not-a-hash')).toBe(false);
  });
});

describe('isAllowedContentType', () => {
  it('allows a PNG image', () => {
    expect(isAllowedContentType(makeResult('png', 'image/png'))).toBe(true);
  });

  it('allows a PDF document', () => {
    expect(isAllowedContentType(makeResult('pdf', 'application/pdf'))).toBe(true);
  });

  it('allows an MP4 video', () => {
    expect(isAllowedContentType(makeResult('mp4', 'video/mp4'))).toBe(true);
  });

  it('rejects an ELF executable', () => {
    expect(isAllowedContentType(makeResult('elf'))).toBe(false);
  });

  it('rejects a Windows PE executable', () => {
    expect(isAllowedContentType(makeResult('pebin'))).toBe(false);
  });

  it('rejects a Mach-O executable', () => {
    expect(isAllowedContentType(makeResult('macho'))).toBe(false);
  });

  it('rejects HTML', () => {
    expect(isAllowedContentType(makeResult('html'))).toBe(false);
  });

  it('rejects SVG', () => {
    expect(isAllowedContentType(makeResult('svg'))).toBe(false);
  });

  it('rejects JavaScript', () => {
    expect(isAllowedContentType(makeResult('javascript'))).toBe(false);
  });

  it('rejects a Python script', () => {
    expect(isAllowedContentType(makeResult('python'))).toBe(false);
  });

  it('rejects a shell script', () => {
    expect(isAllowedContentType(makeResult('shell'))).toBe(false);
  });
});

describe('detectContentType', () => {
  it('classifies real PNG bytes as png via the loaded magika model', async () => {
    const result = await detectContentType(PNG_BYTES);
    expect(result.source).toBe('magika');
    expect(result.label).toBe('png');
    expect(result.mimeType).toBe('image/png');
  }, 15000);

  it('classifies real PDF bytes as pdf', async () => {
    const result = await detectContentType(PDF_BYTES);
    expect(result.label).toBe('pdf');
  }, 15000);

  it('classifies a real ELF executable as elf, which isAllowedContentType then rejects', async () => {
    const result = await detectContentType(makeElf64());
    expect(result.label).toBe('elf');
    expect(isAllowedContentType(result)).toBe(false);
  }, 15000);
});
