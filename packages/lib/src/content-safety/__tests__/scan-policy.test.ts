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

  it('reads text as text, and does not mistake it for a bitmap', () => {
    expect(sniffContentType(text('BMW owners club notes'))).toBe('text');
    expect(sniffContentType(text('héllo — ünïcode'))).toBe('text');
    expect(sniffContentType(text('body { color: red }\n'))).toBe('text');
  });

  it('a multi-byte character cut at the end of the read is still text', () => {
    const full = text('ab€');
    expect(sniffContentType(full.subarray(0, full.length - 1))).toBe('text');
  });

  it('opaque bytes are recognised as nothing', () => {
    expect(sniffContentType(bytes(0x00, 0x13, 0x88, 0xfe, 0x01, 0x02))).toBeNull();
    expect(sniffContentType(bytes(0xc3, 0x28, 0x41, 0x42))).toBeNull(); // short and not UTF-8: proves nothing
  });

  it('recognises the image and video containers a scanner cannot read', () => {
    expect(sniffContentType(bytes(0, 0, 1, 0, 1, 0, 16, 16))).toBe('image/x-icon');
    expect(sniffContentType(bytes(0xff, 0x0a, 0xfa))).toBe('image/jxl');
    expect(sniffContentType(bytes(0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20))).toBe('image/jp2');
    expect(sniffContentType(text('OggS\0\x02' + '\0'.repeat(22) + '\x80theora'))).toBe('video/ogg');
    expect(sniffContentType(text('OggS\0\x02' + '\0'.repeat(22) + 'unknown'))).toBe('video/ogg');
  });

  it('recognises audio and fonts by their bytes', () => {
    expect(sniffContentType(text('ID3\x04'))).toBe('audio');
    expect(sniffContentType(bytes(0xff, 0xfb, 0x90, 0x00))).toBe('audio');
    expect(sniffContentType(text('wOF2\0\x01'))).toBe('font');
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

  it('a zip is a document only by its first entry, never by its declared type', () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(classifyMedia('archive', DOCX).class).toBe('never_promote');
    expect(classifyMedia('zip_document', 'application/zip').class).toBe('unscanned_allowed');
  });

  it('holds images and video the vendor cannot read, and claimed pictures with unrecognised bytes', () => {
    expect(classifyMedia('image/bmp', 'image/bmp').class).toBe('never_promote');
    expect(classifyMedia('video/webm', 'video/webm').class).toBe('never_promote');
    expect(classifyMedia(null, 'image/png').class).toBe('never_promote');
  });

  it('allows text, SVG, audio and fonts unscanned when the bytes are what they claim', () => {
    for (const type of ['text/plain', 'text/css; charset=utf-8', 'image/svg+xml', 'application/json']) {
      expect(classifyMedia('text', type).class).toBe('unscanned_allowed');
    }
    expect(classifyMedia('audio', 'audio/mpeg').class).toBe('unscanned_allowed');
    expect(classifyMedia('font', 'font/woff2').class).toBe('unscanned_allowed');
  });

  it('never trusts a declared text, audio or font type over opaque bytes', () => {
    for (const type of ['text/plain', 'audio/mpeg', 'audio/ogg', 'font/woff', 'application/pdf', 'image/svg+xml']) {
      expect(classifyMedia(null, type).class).toBe('never_promote');
    }
  });

  it('holds Ogg video, ICO, JPEG XL and JPEG 2000 whatever they are declared as', () => {
    expect(classifyMedia('video/ogg', 'audio/ogg').class).toBe('never_promote');
    expect(classifyMedia('image/x-icon', 'text/plain').class).toBe('never_promote');
    expect(classifyMedia('image/jxl', 'text/plain').class).toBe('never_promote');
    expect(classifyMedia('image/jp2', 'audio/mpeg').class).toBe('never_promote');
  });

  it('holds text that claims to be a raster picture', () => {
    expect(classifyMedia('text', 'image/png').class).toBe('never_promote');
  });

  it('allows legacy Office (OLE) documents unscanned (a known gap, like PDFs)', () => {
    expect(classifyMedia('ole_document', 'application/msword').class).toBe('unscanned_allowed');
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

  it('a cached unscanned classification promotes only what is allowed unscanned', () => {
    expect(decideGate('enforce', { kind: 'cached_unscanned', allowed: true })).toMatchObject({ promote: true, record: null, audit: null });
    expect(decideGate('enforce', { kind: 'cached_unscanned', allowed: false })).toMatchObject({ promote: false, record: null });
    expect(decideGate('shadow', { kind: 'cached_unscanned', allowed: false }).promote).toBe(true);
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

/** One Ogg page: "OggS", version, header type, granule, serial, sequence, CRC, one segment, then the packet. */
function oggPage(packet: string, beginningOfStream: boolean): Uint8Array {
  const data = new TextEncoder().encode(packet);
  const header = new Uint8Array(27 + 1);
  header.set(new TextEncoder().encode('OggS'), 0);
  header[5] = beginningOfStream ? 0x02 : 0x00;
  header[26] = 1;
  header[27] = data.length;
  const page = new Uint8Array(header.length + data.length);
  page.set(header, 0);
  page.set(data, header.length);
  return page;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A minimal ISO-BMFF file with the given brand and handler boxes. */
function isoFile(brand: string, handlers: string[]): Uint8Array {
  const ftyp = `\0\0\0\x14ftyp${brand}\0\0\0\0${brand}`;
  const hdlrs = handlers.map((handler) => `\0\0\0\x21hdlr\0\0\0\0\0\0\0\0${handler}\0\0\0\0\0\0\0\0\0\0\0\0\0`).join('');
  return Uint8Array.from(`${ftyp}\0\0\0\x08moov${hdlrs}`, (c) => c.charCodeAt(0));
}

describe('sniffContentType: containers that can hide a video', () => {
  it('an MP4 with an audio brand is audio only when complete and every track is sound', () => {
    expect(sniffContentType(isoFile('M4A ', ['soun']), { complete: true })).toBe('audio');
    expect(sniffContentType(isoFile('M4A ', ['soun', 'vide']), { complete: true })).toBe('video/mp4');
    expect(sniffContentType(isoFile('M4A ', ['soun']), { complete: false })).toBe('video/mp4');
    expect(sniffContentType(isoFile('M4A ', []), { complete: true })).toBe('video/mp4');
  });

  it('an Ogg file is audio only when every stream it opens is audio', () => {
    const vorbis = oggPage('\x01vorbis' + 'x'.repeat(20), true);
    const opus = oggPage('OpusHead' + 'x'.repeat(10), true);
    const theora = oggPage('\x80theora' + 'x'.repeat(20), true);
    const data = oggPage('audio data', false);
    expect(sniffContentType(concat(vorbis, data))).toBe('audio');
    expect(sniffContentType(concat(vorbis, opus, data))).toBe('audio');
    expect(sniffContentType(concat(vorbis, theora, data))).toBe('video/ogg');
    expect(sniffContentType(concat(theora, vorbis, data))).toBe('video/ogg');
    // The headers run past the bytes read: unknown, so video.
    expect(sniffContentType(vorbis)).toBe('video/ogg');
  });

  it('a zip is a document only when its first entry is the format manifest', () => {
    const zipWith = (name: string) => {
      const head = new Uint8Array(30 + name.length);
      head.set([0x50, 0x4b, 0x03, 0x04], 0);
      head[26] = name.length;
      head.set(new TextEncoder().encode(name), 30);
      return head;
    };
    expect(sniffContentType(zipWith('[Content_Types].xml'))).toBe('zip_document');
    expect(sniffContentType(zipWith('mimetype'))).toBe('zip_document');
    expect(sniffContentType(zipWith('photo1.jpg'))).toBe('archive');
  });

  it('reads Latin-1 text as text, but only from a sample long enough to mean something', () => {
    const latin1 = Uint8Array.from('Jos\xe9,M\xfcnchen,'.repeat(6), (c) => c.charCodeAt(0));
    expect(sniffContentType(latin1)).toBe('text');
    expect(sniffContentType(Uint8Array.from('Jos\xe9!', (c) => c.charCodeAt(0)))).toBeNull();
  });

  it('needs a plausible table count to call something a TrueType or OpenType font', () => {
    expect(sniffContentType(text('true story, told plainly'))).toBe('text');
    expect(sniffContentType(bytes(0, 1, 0, 0, 0, 12, 0, 128))).toBe('font');
  });
});
