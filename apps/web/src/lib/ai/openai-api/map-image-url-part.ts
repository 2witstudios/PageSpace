/**
 * Pure mapper from an OpenAI-format `image_url` content part to PageSpace's internal
 * file-part shape (mirrors the AI SDK's FileUIPart). Extracted so the OpenAI-compat
 * message normalizer (validate-inference-request.ts) stays a thin caller and the
 * mapping/rejection rules are unit-testable in isolation.
 *
 * PageSpace only accepts inline data: URLs for images — there is no server-side fetch
 * of remote URLs, so a remote http(s) image_url is rejected here rather than silently
 * dropped or fetched.
 */
export interface FilePart {
  type: 'file';
  url: string;
  mediaType?: string;
  filename?: string;
}

export type ImageUrlMapResult =
  | { ok: true; part: FilePart }
  | { ok: false; error: string };

const DATA_URL_MEDIA_TYPE = /^data:([^;,]+)/;

export const mapImageUrlPartToFilePart = (part: Record<string, unknown>): ImageUrlMapResult => {
  const imageUrl = part.image_url as Record<string, unknown> | undefined;
  const url = typeof imageUrl?.url === 'string' ? imageUrl.url : undefined;

  if (!url) {
    return { ok: false, error: 'image_url part must have image_url.url (string)' };
  }
  if (!url.startsWith('data:')) {
    return { ok: false, error: 'image_url must be a data: URL — remote image URLs are not supported' };
  }

  const match = DATA_URL_MEDIA_TYPE.exec(url);
  return { ok: true, part: { type: 'file', url, mediaType: match?.[1] } };
};
