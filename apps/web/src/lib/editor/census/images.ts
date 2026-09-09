import type { DomElement } from './constructs';

/**
 * Where the images in stored documents actually point.
 *
 * The first production run reported `<img>` on zero pages and that number is
 * worthless: the editor has no image node, so no document can contain one. It
 * is the absence of an unimplemented feature, not evidence about the schema.
 * The real image population is in markdown source — the ~1,000 documents
 * labelled `contentMode='markdown'` and the ~3,000 more mislabelled as HTML —
 * and what those images point AT is the part that has to be decided before v1
 * is frozen, because an image node's attributes are as permanent as the node:
 *
 *   - `data:` is the hazard. Base64 bytes written into a Y.Doc are replicated
 *     to every client and never forgotten, so if any exist today the paste and
 *     migration paths have to reject them rather than carry them across.
 *   - an external host means v1 either hotlinks it forever or ingests it once,
 *     and Phase K is the only cheap moment to ingest.
 *   - `/api/files/{id}/view` means the asset is already PageSpace-hosted and
 *     the node can hold a stable internal id instead of a URL. A signed URL
 *     written into a CRDT is permanent, expiring and leaky, all at once.
 *
 * NEVER RETURNS A URL. A src carries a filename, sometimes a query string, and
 * a query string sometimes carries a token; this census runs against production
 * user data. What leaves this module is a scheme bucket and, for external
 * images, a bare hostname — enough to answer "whose images are these", and
 * nothing else. A URL with credentials in it loses even the hostname.
 */
export const IMAGE_SOURCE_KEYS = {
  dataUri: 'img-src:data-uri',
  pagespaceFile: 'img-src:pagespace-file',
  externalHttps: 'img-src:external-https',
  externalHttp: 'img-src:external-http',
  relative: 'img-src:relative',
  otherScheme: 'img-src:other-scheme',
  malformed: 'img-src:malformed',
} as const;

/** The bucket keys themselves, so a tally cannot be filed under a typo. */
export type ImageSourceBucket = (typeof IMAGE_SOURCE_KEYS)[keyof typeof IMAGE_SOURCE_KEYS];

export interface ImageSource {
  bucket: ImageSourceBucket;
  /** Bare hostname for external images; null for everything else. */
  host: string | null;
}

/** `/api/files/{pageId}/view`, the URL `ImageViewer` already serves images from. */
const PAGESPACE_FILE_PATH = /^\/api\/files\/[^/]+\/(view|thumbnail)$/;

/**
 * A scheme-relative `//host/path` inherits the page's scheme, which in
 * production is https. Parsing it needs a base, and the base is never reported.
 */
const SCHEME_RELATIVE_BASE = 'https://scheme.relative.invalid';

/**
 * A src that announces itself as absolute — `https://`, `mailto:`, `//host` —
 * and then fails to parse is broken, not relative. `https://` on its own is the
 * case that matters: a truncated paste, which would otherwise be filed as a
 * relative path and look like a migration problem instead of a broken image.
 */
const ANNOUNCES_A_SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function hostOf(url: URL): string | null {
  // Credentials in a src are rare enough to be interesting and sensitive enough
  // that the host they belong to is not worth printing next to the count.
  if (url.username !== '' || url.password !== '') return null;
  return url.hostname === '' ? null : url.hostname.toLowerCase();
}

export function classifyImageSource(src: string): ImageSource {
  const trimmed = src.trim();
  if (trimmed === '') return { bucket: IMAGE_SOURCE_KEYS.malformed, host: null };

  // Matched before parsing: a data URI is megabytes of base64 and `new URL` on
  // one is pointless work repeated per image per document.
  if (/^data:/i.test(trimmed)) return { bucket: IMAGE_SOURCE_KEYS.dataUri, host: null };

  const schemeRelative = trimmed.startsWith('//');
  let url: URL;
  try {
    url = schemeRelative ? new URL(trimmed, SCHEME_RELATIVE_BASE) : new URL(trimmed);
  } catch {
    // Not absolute. Relative to what, though, is the open question: markdown
    // written elsewhere and pasted in carries `./images/x.png` paths that
    // resolve against nothing here, and they are a migration problem whether or
    // not they are well-formed.
    if (ANNOUNCES_A_SCHEME.test(trimmed)) {
      return { bucket: IMAGE_SOURCE_KEYS.malformed, host: null };
    }
    return {
      bucket: PAGESPACE_FILE_PATH.test(trimmed.split('?')[0])
        ? IMAGE_SOURCE_KEYS.pagespaceFile
        : IMAGE_SOURCE_KEYS.relative,
      host: null,
    };
  }

  if (schemeRelative || url.protocol === 'https:') {
    if (PAGESPACE_FILE_PATH.test(url.pathname)) {
      return { bucket: IMAGE_SOURCE_KEYS.pagespaceFile, host: null };
    }
    return { bucket: IMAGE_SOURCE_KEYS.externalHttps, host: hostOf(url) };
  }

  if (url.protocol === 'http:') {
    if (PAGESPACE_FILE_PATH.test(url.pathname)) {
      return { bucket: IMAGE_SOURCE_KEYS.pagespaceFile, host: null };
    }
    return { bucket: IMAGE_SOURCE_KEYS.externalHttp, host: hostOf(url) };
  }

  // blob: and file: are the ones that matter here — both are references to
  // something only one browser on one machine can resolve, and both would seed
  // a permanently broken image.
  return { bucket: IMAGE_SOURCE_KEYS.otherScheme, host: null };
}

/** Every `<img>` in a stored HTML document, classified. */
export function htmlImageSources(container: DomElement): ImageSource[] {
  const sources: ImageSource[] = [];
  for (const image of container.querySelectorAll('img')) {
    sources.push(classifyImageSource(image.getAttribute('src') ?? ''));
  }
  return sources;
}
