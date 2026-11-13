import { describe, expect, it } from 'vitest';
import { classifyMedia, decideGate, isVerdictFresh, sniffContentType, type GateOutcome } from '../scan-policy';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('sniffContentType', () => {
  it('recognises the scannable image and video types', () => {
    expect(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffContentType(text('GIF89a'))).toBe('image/gif');
    expect(sniffContentType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffContentType(text('\0\0\0\x18ftypisom'))).toBe('video/mp4');
    expect(sniffContentType(text('\0\0\0\x14ftypqt  '))).toBe('video/quicktime');
  });

  it('recognises documents, archives, executables and our encrypted envelope', () => {
    expect(sniffContentType(text('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffContentType(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('archive');
    expect(sniffContentType(bytes(0x1f, 0x8b, 0x08))).toBe('archive');
    expect(sniffContentType(bytes(0x7f, 0x45, 0x4c, 0x46))).toBe('executable');
    expect(sniffContentType(text('PSE1xxxx'))).toBe('encrypted_envelope');
    expect(sniffContentType(text('\0\0\0\x18ftypheic'))).toBe('image/heic');
  });

  it('does not mistake text for a bitmap', () => {
    expect(sniffContentType(text('BMW owners club notes'))).toBeNull();
    expect(sniffContentType(text('hello'))).toBeNull();
  });
});

describe('classifyMedia', () => {
  it('scans what the bytes say is an image, whatever the uploader declared', () => {
    expect(classifyMedia('image/jpeg', 'application/pdf')).toEqual({ class: 'scan', mediaKind: 'image', contentType: 'image/jpeg' });
    expect(classifyMedia('video/mp4', 'text/plain')).toMatchObject({ class: 'scan', mediaKind: 'video' });
  });

  it('lets PDFs through unscanned (a known gap)', () => {
    expect(classifyMedia('application/pdf', 'application/pdf')).toEqual({ class: 'unscanned_allowed', contentType: 'application/pdf' });
  });

  it('never promotes archives, executables or opaque binaries', () => {
    expect(classifyMedia('archive', 'application/zip').class).toBe('never_promote');
    expect(classifyMedia('executable', 'application/octet-stream').class).toBe('never_promote');
    expect(classifyMedia(null, 'application/octet-stream').class).toBe('never_promote');
    expect(classifyMedia(null, null).class).toBe('never_promote');
    expect(classifyMedia('encrypted_envelope', 'image/png').class).toBe('never_promote');
  });

  it('allows zip-based office documents declared as such', () => {
    expect(classifyMedia('archive', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').class).toBe('unscanned_allowed');
  });

  it('holds images and video the vendor cannot read, and claimed pictures with unrecognised bytes', () => {
    expect(classifyMedia('image/bmp', 'image/bmp').class).toBe('never_promote');
    expect(classifyMedia('video/webm', 'video/webm').class).toBe('never_promote');
    expect(classifyMedia(null, 'image/png').class).toBe('never_promote');
  });

  it('allows text, audio, fonts and SVG unscanned', () => {
    for (const type of ['text/plain', 'text/css; charset=utf-8', 'audio/mpeg', 'font/woff2', 'image/svg+xml', 'application/json']) {
      expect(classifyMedia(null, type).class).toBe('unscanned_allowed');
    }
  });
});

describe('decideGate', () => {
  const clean: GateOutcome = { kind: 'scanned', result: { kind: 'clean', provider: 'p' } };
  const match: GateOutcome = { kind: 'scanned', result: { kind: 'hash_match', provider: 'p', lists: ['l'], matchTypes: ['CSAM'] } };
  const flag: GateOutcome = { kind: 'scanned', result: { kind: 'classifier_flag', provider: 'p', category: 'csam', score: 0.97 } };
  const error: GateOutcome = { kind: 'scanned', result: { kind: 'error', provider: 'p', reason: 'timeout' } };
  const archive: GateOutcome = { kind: 'not_scanned', media: { class: 'never_promote', contentType: 'archive' } };
  const pdf: GateOutcome = { kind: 'not_scanned', media: { class: 'unscanned_allowed', contentType: 'application/pdf' } };

  it('clean promotes and records in both modes', () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      expect(decideGate(mode, clean)).toMatchObject({ promote: true, record: { verdict: 'clean' }, audit: 'content.scan.clean' });
    }
  });

  it('a hash match is never shadow: no promotion and a takedown in both modes', () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      expect(decideGate(mode, match)).toMatchObject({ promote: false, takedown: true, reviewCase: false, record: { verdict: 'flagged', outcome: 'hash_match' } });
    }
  });

  it('a classifier flag opens a review case; enforce holds, shadow promotes; never a takedown', () => {
    expect(decideGate('enforce', flag)).toMatchObject({ promote: false, reviewCase: true, takedown: false, record: { verdict: 'flagged' } });
    expect(decideGate('shadow', flag)).toMatchObject({ promote: true, reviewCase: true, takedown: false });
  });

  it('an error or timeout holds under enforce and records the error for a retry', () => {
    expect(decideGate('enforce', error)).toMatchObject({ promote: false, record: { verdict: 'error' }, audit: 'content.scan.error' });
    expect(decideGate('shadow', error).promote).toBe(true);
  });

  it('archives are held under enforce; PDFs promote unscanned and are recorded', () => {
    expect(decideGate('enforce', archive)).toMatchObject({ promote: false, record: { verdict: 'unscanned' } });
    expect(decideGate('shadow', archive).promote).toBe(true);
    expect(decideGate('enforce', pdf)).toMatchObject({ promote: true, record: { verdict: 'unscanned' }, audit: 'content.scan.unscanned' });
  });

  it('no scanner: enforce fails closed, shadow changes nothing', () => {
    expect(decideGate('enforce', { kind: 'scanner_unavailable' })).toMatchObject({ promote: false, record: null });
    expect(decideGate('shadow', { kind: 'scanner_unavailable' })).toMatchObject({ promote: true, record: null });
  });

  it('a cached flag holds under enforce without a new case', () => {
    expect(decideGate('enforce', { kind: 'cached_flagged' })).toMatchObject({ promote: false, reviewCase: false, record: null });
    expect(decideGate('enforce', { kind: 'cached_clean' })).toMatchObject({ promote: true, record: null });
  });
});

describe('isVerdictFresh', () => {
  const now = new Date('2026-11-13T00:00:00Z');
  it('trusts a verdict younger than the TTL only', () => {
    expect(isVerdictFresh(new Date('2026-11-12T00:00:00Z'), 2 * 86_400_000, now)).toBe(true);
    expect(isVerdictFresh(new Date('2026-11-10T00:00:00Z'), 2 * 86_400_000, now)).toBe(false);
    expect(isVerdictFresh(new Date('2026-11-14T00:00:00Z'), 2 * 86_400_000, now)).toBe(false);
  });
});
