/**
 * Publish-gate policy — pure: what the bytes are, and what the gate does with
 * each outcome in each mode. No I/O.
 */

import type { ContentScanOutcome, ContentScanVerdict } from '@pagespace/db/schema/content-safety';
import type { ScanMediaKind, ScanResult } from './scanner';

// ---------------------------------------------------------------------------
// What the bytes are
// ---------------------------------------------------------------------------

/**
 * Content type read from the first bytes. The declared type comes from the
 * uploader and decides nothing on its own: a JPEG labelled `application/pdf`
 * would otherwise skip the scan and still render in an `<img>`. Anything the
 * bytes do not identify is opaque unless it reads as text.
 */
export type SniffedType =
  | 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  | 'image/bmp' | 'image/tiff' | 'image/heic' | 'image/avif' | 'image/x-icon' | 'image/jxl' | 'image/jp2'
  | 'video/mp4' | 'video/quicktime' | 'video/webm' | 'video/x-msvideo' | 'video/ogg'
  | 'application/pdf'
  /** A recognised audio container or stream (ID3/MPEG, AAC, FLAC, WAV, AIFF, Ogg audio, M4A, MIDI, AMR). */
  | 'audio'
  /** A recognised font (WOFF, WOFF2, OpenType, TrueType, collection). */
  | 'font'
  /** Legacy Office (OLE compound file). */
  | 'ole_document'
  /** OOXML, ODF or EPUB: a zip whose first entry is the format's manifest. Can embed images (a known gap). */
  | 'zip_document'
  /** No NUL or stray control bytes, valid UTF-8 (or UTF-16 with a BOM). */
  | 'text'
  | 'archive' | 'executable' | 'encrypted_envelope';

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const OGG_AUDIO_CODECS = ['\x01vorbis', 'OpusHead', 'Speex   ', '\x7fFLAC'];

/**
 * Audio only when EVERY stream in an Ogg file is an audio codec. A multiplexed file opens all its streams
 * first (pages flagged "beginning of stream"), so they are all walked: any other codec (Theora, VP8, Daala,
 * Skeleton, unknown), a malformed page, or running out of bytes before the first non-opening page means video.
 */
function oggKind(bytes: Uint8Array, complete: boolean): 'audio' | 'video/ogg' {
  const first = firstOggLink(bytes);
  if (first !== 'audio') return first;
  // A chained file can open new streams in a later link. Audio only if the whole file is in hand and every
  // stream-opening page anywhere in it is audio; a partial read could hide a later video link.
  if (!complete) return 'video/ogg';
  const text = LATIN1.decode(bytes);
  for (let at = text.indexOf('OggS'); at !== -1; at = text.indexOf('OggS', at + 4)) {
    if (at + 27 > bytes.length || (bytes[at + 5] & 0x02) === 0) continue;
    const dataStart = at + 27 + bytes[at + 26];
    if (!OGG_AUDIO_CODECS.some((codec) => ascii(bytes, dataStart, codec.length) === codec)) return 'video/ogg';
  }
  return 'audio';
}

function firstOggLink(bytes: Uint8Array): 'audio' | 'video/ogg' {
  let offset = 0;
  let streams = 0;
  while (offset + 27 <= bytes.length) {
    if (ascii(bytes, offset, 4) !== 'OggS') return 'video/ogg';
    const headerType = bytes[offset + 5];
    const segments = bytes[offset + 26];
    const dataStart = offset + 27 + segments;
    if (dataStart > bytes.length) return 'video/ogg';
    let dataLength = 0;
    for (let i = 0; i < segments; i++) dataLength += bytes[offset + 27 + i];
    if ((headerType & 0x02) === 0) return streams > 0 ? 'audio' : 'video/ogg'; // every stream has been opened
    streams++;
    if (!OGG_AUDIO_CODECS.some((codec) => ascii(bytes, dataStart, codec.length) === codec)) return 'video/ogg';
    offset = dataStart + dataLength;
  }
  return 'video/ogg';
}

/**
 * Audio only when the WHOLE file is in hand and every track handler in it is sound. An MP4 with an audio
 * brand plays as video if it has a video track, so the brand alone decides nothing; a partial read is video.
 */
function isoAudioOnly(bytes: Uint8Array, complete: boolean): boolean {
  if (!complete) return false;
  const text = LATIN1.decode(bytes); // one char per byte, without spreading a large file into arguments
  let sound = false;
  for (let at = text.indexOf('hdlr'); at !== -1; at = text.indexOf('hdlr', at + 4)) {
    const handler = text.slice(at + 12, at + 16);
    if (handler === 'soun') sound = true;
    else if (handler !== 'meta' && handler !== 'hint' && handler !== 'text' && handler !== 'sbtl' && handler !== 'mdir') return false;
  }
  return sound;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const LATIN1 = new TextDecoder('latin1');

/**
 * Whether bytes read as text: no NUL or stray control bytes, and valid UTF-8 (a cut-off last character is
 * allowed) — or, for at least 64 bytes, a single-byte encoding such as Latin-1 or Windows-1252.
 */
export function looksLikeText(head: Uint8Array): boolean {
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) {
    // UTF-16 with a BOM: every other byte is commonly NUL, so check the code units instead.
    for (let i = 2; i + 1 < head.length; i += 2) {
      const unit = startsWith(head, [0xff, 0xfe]) ? head[i] | (head[i + 1] << 8) : (head[i] << 8) | head[i + 1];
      if (unit === 0 || (unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d && unit !== 0x0c && unit !== 0x1b)) return false;
    }
    return true;
  }
  for (const byte of head) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1b) return false;
    if (byte === 0x7f) return false;
  }
  for (let trim = 0; trim <= 3 && trim <= head.length; trim++) {
    // Only a cut-off multi-byte character may be dropped: a lead byte followed only by continuation bytes.
    if (trim > 0) {
      const tail = head.subarray(head.length - trim);
      if (tail[0] < 0xc0 || tail.subarray(1).some((byte) => byte < 0x80 || byte > 0xbf)) continue;
    }
    try {
      UTF8.decode(head.subarray(0, head.length - trim));
      return true;
    } catch {
      // A multi-byte character may have been cut at the end of the read; try without it.
    }
  }
  // Not UTF-8 but free of control bytes: a legacy single-byte text encoding. Too short a sample proves nothing.
  return head.length >= 64;
}

/** A TrueType/OpenType table count that a real font would have. */
const plausibleTables = (head: Uint8Array): boolean => {
  const tables = head.length >= 6 ? (head[4] << 8) | head[5] : 0;
  return tables >= 1 && tables <= 64;
};

const OOXML_FIRST_ENTRIES = ['[Content_Types].xml', '_rels/.rels'];

/** The name of a zip's first entry, from its local file header. */
function firstZipEntry(head: Uint8Array): string | null {
  if (!startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || head.length < 30) return null;
  const nameLength = head[26] | (head[27] << 8);
  return head.length >= 30 + nameLength ? ascii(head, 30, nameLength) : null;
}

/** Document types an ODF or EPUB `mimetype` entry may name. */
const ZIP_DOCUMENT_MIMETYPE = /^(application\/vnd\.oasis\.opendocument\.[a-z0-9.+-]+|application\/epub\+zip)$/;

/**
 * Whether a zip's first entry is an ODF / EPUB `mimetype` entry: stored uncompressed, as those formats require,
 * and naming a document type. A name alone proves nothing: any archive can put an empty `mimetype` first.
 */
function isDocumentMimetypeEntry(head: Uint8Array): boolean {
  const method = head[8] | (head[9] << 8);
  const size = (head[18] | (head[19] << 8) | (head[20] << 16)) + head[21] * 0x1000000;
  const nameLength = head[26] | (head[27] << 8);
  const extraLength = head[28] | (head[29] << 8);
  const start = 30 + nameLength + extraLength;
  if (method !== 0 || size === 0 || size > 100 || head.length < start + size) return false;
  return ZIP_DOCUMENT_MIMETYPE.test(ascii(head, start, size));
}

/**
 * Sniff a file. `complete` says whether `head` is the whole file (some answers need it all, e.g. whether an
 * MP4 has a video track). Null when nothing is recognised: the bytes are opaque.
 */
export function sniffContentType(head: Uint8Array, { complete = false }: { complete?: boolean } = {}): SniffedType | null {
  if (startsWith(head, [0x50, 0x53, 0x45, 0x31])) return 'encrypted_envelope'; // our at-rest envelope, "PSE1"
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(head, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'AVI ') return 'video/x-msvideo';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'audio';
  // BMP: "BM", then a size, then four reserved zero bytes.
  if (ascii(head, 0, 2) === 'BM' && startsWith(head, [0, 0, 0, 0], 6)) return 'image/bmp';
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  // ICO / CUR: reserved 0, type 1 or 2, then a non-zero image count.
  if ((startsWith(head, [0, 0, 1, 0]) || startsWith(head, [0, 0, 2, 0])) && head.length >= 6 && (head[4] | head[5]) !== 0) return 'image/x-icon';
  if (startsWith(head, [0xff, 0x0a]) || startsWith(head, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return 'image/jxl';
  if (startsWith(head, [0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20]) || startsWith(head, [0xff, 0x4f, 0xff, 0x51])) return 'image/jp2';
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (brand === 'qt  ') return 'video/quicktime';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B '].includes(brand) && isoAudioOnly(head, complete)) return 'audio';
    return 'video/mp4';
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(head, 0, 4) === 'OggS') return oggKind(head, complete);
  if (ascii(head, 0, 5) === '%PDF-') return 'application/pdf';
  // A document in a zip container, by its first entry (the formats require it). Any other zip is an archive.
  const firstEntry = firstZipEntry(head);
  if (firstEntry !== null && (OOXML_FIRST_ENTRIES.includes(firstEntry) || (firstEntry === 'mimetype' && isDocumentMimetypeEntry(head)))) {
    return 'zip_document';
  }
  if (
    startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || // zip (and every zip-based format)
    startsWith(head, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(head, [0x1f, 0x8b]) || // gzip
    startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || // 7z
    ascii(head, 0, 4) === 'Rar!' ||
    ascii(head, 0, 3) === 'BZh' ||
    startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) || // xz
    ascii(head, 257, 5) === 'ustar' // tar
  ) return 'archive';
  if (
    startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    ascii(head, 0, 2) === 'MZ' || // PE
    startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(head, [0xfe, 0xed, 0xfa, 0xcf]) || // Mach-O
    startsWith(head, [0xca, 0xfe, 0xba, 0xbe])
  ) return 'executable';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole_document';
  if (['wOFF', 'wOF2', 'ttcf'].includes(ascii(head, 0, 4))) return 'font';
  if ((['OTTO', 'true'].includes(ascii(head, 0, 4)) || startsWith(head, [0, 1, 0, 0])) && plausibleTables(head)) return 'font';
  if (
    ascii(head, 0, 3) === 'ID3' ||
    ascii(head, 0, 4) === 'fLaC' ||
    ascii(head, 0, 4) === 'MThd' ||
    ascii(head, 0, 5) === '#!AMR' ||
    (ascii(head, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(head, 8, 4)))
  ) return 'audio';
  // Text is judged on the whole file only: a large file read in part could be an archive behind a text prefix.
  if (complete && looksLikeText(head)) return 'text';
  // MPEG audio / AAC ADTS frame sync. Checked after text: text never starts 0xFF.
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio';
  return null;
}

/** Types the vendor can scan. Everything else that is an image or video can't be checked. */
const SCANNABLE: Partial<Record<SniffedType, ScanMediaKind>> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
};

/**
 * Published without a scan: these cannot be a picture or a video themselves (PDFs and documents can embed
 * images: a known gap, like SVG). Decided by the bytes alone, so a cached classification holds for every
 * file with the same hash whatever it is declared as.
 */
const ALLOWED_UNSCANNED: ReadonlySet<SniffedType> = new Set(['application/pdf', 'audio', 'font', 'zip_document', 'ole_document']);

export type MediaClass =
  | { class: 'scan'; mediaKind: ScanMediaKind; contentType: string }
  /** Published without a scan and logged: PDFs, text, audio, fonts, office documents, SVG. */
  | { class: 'unscanned_allowed'; contentType: string }
  /** Never promoted under enforce: archives, executables, opaque binaries, images or video the vendor can't read. */
  | { class: 'never_promote'; contentType: string };

const baseType = (declared: string | null | undefined): string =>
  (declared ?? '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';

/**
 * Decide how to treat a file. The bytes decide; the declared type only
 * separates documents from archives in the same container, and a claimed
 * picture from text. Bytes nothing recognises are opaque and never promoted
 * under enforce, whatever the uploader called them.
 */
export function classifyMedia(sniffed: SniffedType | null, declaredContentType: string | null | undefined): MediaClass {
  const declared = baseType(declaredContentType);
  if (!sniffed) return { class: 'never_promote', contentType: declared };

  const kind = SCANNABLE[sniffed];
  if (kind) return { class: 'scan', mediaKind: kind, contentType: sniffed };
  if (ALLOWED_UNSCANNED.has(sniffed)) return { class: 'unscanned_allowed', contentType: sniffed === 'application/pdf' ? sniffed : declared };
  if (sniffed === 'text') {
    // Text that claims to be a raster image or video cannot be checked; SVG is text and a known gap.
    const claimsPicture = (declared.startsWith('image/') && declared !== 'image/svg+xml') || declared.startsWith('video/');
    return claimsPicture ? { class: 'never_promote', contentType: declared } : { class: 'unscanned_allowed', contentType: declared };
  }
  return { class: 'never_promote', contentType: sniffed };
}

// ---------------------------------------------------------------------------
// What the gate does
// ---------------------------------------------------------------------------

export type GateMode = 'shadow' | 'enforce';

/** Everything the gate can learn about one asset before it decides. */
export type GateOutcome =
  /** A recent `clean` verdict: no scan needed. */
  | { kind: 'cached_clean' }
  /** A recent classifier flag nobody has cleared: no new scan, no new case. */
  | { kind: 'cached_flagged' }
  /** A recent "not scanned" classification: the bytes of a hash never change, so it is not re-read. */
  | { kind: 'cached_unscanned'; allowed: boolean }
  /** A recent `unverified` video (hash pass clean, never classified), while unclassified video is not accepted. */
  | { kind: 'cached_unverified' }
  /** A video the scan ran on whose hash pass was clean but which the classifier never scored. */
  | { kind: 'unverified'; provider: string }
  /** Enforce or shadow with no vendor key. */
  | { kind: 'scanner_unavailable' }
  | { kind: 'not_scanned'; media: Extract<MediaClass, { class: 'unscanned_allowed' | 'never_promote' }> }
  | { kind: 'scanned'; result: ScanResult };

export type ScanAuditEventType =
  | 'content.scan.clean'
  | 'content.scan.hash_match'
  | 'content.scan.flagged'
  | 'content.scan.error'
  | 'content.scan.unscanned'
  | 'content.scan.unverified';

export interface GateDecision {
  promote: boolean;
  /** The verdict to record, or null when nothing new was learned. */
  record: { verdict: ContentScanVerdict; outcome: ContentScanOutcome } | null;
  /** Run the global takedown (category csam): blocks the hash, preserves, removes it everywhere. */
  takedown: boolean;
  /** Open (or join) a case in the review queue and alert. */
  reviewCase: boolean;
  audit: ScanAuditEventType | null;
}

const decision = (partial: Partial<GateDecision> & Pick<GateDecision, 'promote'>): GateDecision => ({
  record: null,
  takedown: false,
  reviewCase: false,
  audit: null,
  ...partial,
});

/**
 * The gate's decision. Shadow mode does everything enforce does — records,
 * cases, alerts, and the takedown on a hash match — but promotes. A known-CSAM
 * match is never "shadow": the takedown runs and the file is not promoted in
 * either mode. (A blocklisted hash never gets this far: it is refused first.)
 */
export function decideGate(mode: GateMode, outcome: GateOutcome): GateDecision {
  const shadow = mode === 'shadow';
  switch (outcome.kind) {
    case 'cached_clean':
      return decision({ promote: true });
    case 'cached_unscanned':
      return decision({ promote: shadow || outcome.allowed });
    case 'cached_flagged':
    case 'cached_unverified':
      return decision({ promote: shadow });
    case 'unverified':
      // Not clean: nothing classified it. Held under enforce; shadow publishes it and records why.
      return decision({ promote: shadow, record: { verdict: 'unverified', outcome: 'unverified' }, audit: 'content.scan.unverified' });
    case 'scanner_unavailable':
      // Enforce without a key fails closed; shadow cannot scan, so it changes nothing.
      return decision({ promote: shadow });
    case 'not_scanned':
      return decision({
        promote: shadow || outcome.media.class === 'unscanned_allowed',
        record: { verdict: 'unscanned', outcome: 'unsupported_type' },
        audit: 'content.scan.unscanned',
      });
    case 'scanned': {
      const { result } = outcome;
      switch (result.kind) {
        case 'clean':
          return decision({ promote: true, record: { verdict: 'clean', outcome: 'clean' }, audit: 'content.scan.clean' });
        case 'hash_match':
          return decision({ promote: false, record: { verdict: 'flagged', outcome: 'hash_match' }, takedown: true, audit: 'content.scan.hash_match' });
        case 'classifier_flag':
          return decision({ promote: shadow, record: { verdict: 'flagged', outcome: 'classifier_flag' }, reviewCase: true, audit: 'content.scan.flagged' });
        case 'error':
          return decision({ promote: shadow, record: { verdict: 'error', outcome: 'error' }, audit: 'content.scan.error' });
        case 'unsupported_type':
          return decision({ promote: shadow, record: { verdict: 'unscanned', outcome: 'unsupported_type' }, audit: 'content.scan.unscanned' });
      }
    }
  }
}

/**
 * A scan that came back clean is only clean if something looked at the content. For a video, the hash pass
 * alone (a clean result with no classifier scores) is `unverified` unless unclassified video is accepted.
 * Images keep the old reading: the classifier legitimately skips tiny images, and the hash pass still ran.
 */
export function refineScanOutcome(
  mediaKind: ScanMediaKind,
  result: ScanResult,
  { allowUnclassifiedVideo }: { allowUnclassifiedVideo: boolean },
): GateOutcome {
  if (mediaKind === 'video' && result.kind === 'clean' && !result.scores && !allowUnclassifiedVideo) {
    return { kind: 'unverified', provider: result.provider };
  }
  return { kind: 'scanned', result };
}

/** Whether a stored verdict is recent enough to trust. */
export function isVerdictFresh(scannedAt: Date, ttlMs: number, now: Date): boolean {
  const age = now.getTime() - scannedAt.getTime();
  return age >= 0 && age < ttlMs;
}
