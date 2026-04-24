import { createUserServiceToken, type ServiceScope } from '@pagespace/lib/services/validated-service-token';
import { loggers } from '@pagespace/lib/logging/logger-config';

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const REQUIRED_AVATAR_SCOPES: ServiceScope[] = ['avatars:write'];

const GOOGLE_AVATAR_HOST_PATTERN = /(^|\.)googleusercontent\.com$/i;

type AvatarMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const ALLOWED_IMAGE_MIME_TYPES = new Set<AvatarMimeType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const MIME_EXTENSION_MAP: Record<AvatarMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

type ResolveGoogleAvatarImageInput = {
  userId: string;
  pictureUrl?: string | null;
  existingImage?: string | null;
};

function getUrlHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowlistedGoogleAvatarUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      GOOGLE_AVATAR_HOST_PATTERN.test(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function parseMimeType(contentTypeHeader: string | null): AvatarMimeType | null {
  if (!contentTypeHeader) {
    return null;
  }

  const mimeType = contentTypeHeader
    .split(';')[0]
    ?.trim()
    .toLowerCase();

  if (!mimeType || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType as AvatarMimeType)) {
    return null;
  }

  return mimeType as AvatarMimeType;
}

function detectMimeType(buffer: Uint8Array): AvatarMimeType | null {
  if (buffer.length >= 8) {
    const isPng =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;
    if (isPng) {
      return 'image/png';
    }
  }

  if (buffer.length >= 3) {
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (isJpeg) {
      return 'image/jpeg';
    }
  }

  if (buffer.length >= 6) {
    const header = String.fromCharCode(
      buffer[0],
      buffer[1],
      buffer[2],
      buffer[3],
      buffer[4],
      buffer[5]
    );
    if (header === 'GIF87a' || header === 'GIF89a') {
      return 'image/gif';
    }
  }

  if (buffer.length >= 12) {
    const riff = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]);
    const webp = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
    if (riff === 'RIFF' && webp === 'WEBP') {
      return 'image/webp';
    }
  }

  return null;
}

async function readResponseBodyWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    throw new Error('Avatar response body is empty');
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors and surface the size-limit failure.
      }
      throw new Error('Avatar file exceeds size limit');
    }

    chunks.push(value);
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer;
}

async function uploadAvatarToProcessor(userId: string, file: File): Promise<string | null> {
  const { token } = await createUserServiceToken(userId, REQUIRED_AVATAR_SCOPES, '5m');

  const formData = new FormData();
  formData.append('file', file);
  formData.append('userId', userId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let processorResponse: Response;

  try {
    processorResponse = await fetch(`${PROCESSOR_URL}/api/avatar/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      loggers.auth.warn('Processor avatar upload timed out', {
        userId,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!processorResponse.ok) {
    const details = await processorResponse.text().catch(() => 'unknown processor error');
    loggers.auth.warn('Processor rejected Google avatar upload', {
      userId,
      status: processorResponse.status,
      details: details.slice(0, 200),
    });
    return null;
  }

  const payload: unknown = await processorResponse.json().catch(() => null);
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('filename' in payload) ||
    typeof payload.filename !== 'string' ||
    payload.filename.length === 0
  ) {
    loggers.auth.warn('Processor returned invalid avatar upload response', { userId });
    return null;
  }

  const safeFilename = payload.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  if (
    safeFilename !== payload.filename ||
    safeFilename.length === 0 ||
    safeFilename.includes('..')
  ) {
    loggers.auth.warn('Processor returned suspicious avatar filename', {
      userId,
      filename: payload.filename,
    });
    return null;
  }

  const avatarUrl = `/api/avatar/${userId}/${safeFilename}?t=${Date.now()}`;
  loggers.auth.debug('Google avatar uploaded to local storage', {
    userId,
    avatarUrl,
  });
  return avatarUrl;
}

export function isExternalHttpUrl(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^https?:\/\//i.test(value);
}

export async function resolveGoogleAvatarImage({
  userId,
  pictureUrl,
  existingImage,
}: ResolveGoogleAvatarImageInput): Promise<string | null> {
  const currentLocalImage = existingImage && !isExternalHttpUrl(existingImage) ? existingImage : null;

  // Preserve an existing same-origin avatar instead of replacing custom uploads.
  if (currentLocalImage) {
    return currentLocalImage;
  }

  if (!pictureUrl) {
    return null;
  }

  if (!isAllowlistedGoogleAvatarUrl(pictureUrl)) {
    loggers.auth.warn('Rejected non-allowlisted Google avatar URL', {
      userId,
      host: getUrlHostname(pictureUrl) || 'invalid-url',
    });
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(pictureUrl, {
      method: 'GET',
      headers: { Accept: 'image/*' },
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      loggers.auth.warn('Google avatar download failed', {
        userId,
        status: response.status,
        host: getUrlHostname(pictureUrl) || 'unknown',
      });
      return null;
    }

    const declaredMimeType = parseMimeType(response.headers.get('content-type'));
    if (!declaredMimeType) {
      loggers.auth.warn('Google avatar rejected due to unsupported content type', {
        userId,
        contentType: response.headers.get('content-type') || 'missing',
      });
      return null;
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const parsedLength = Number.parseInt(contentLength, 10);
      if (Number.isFinite(parsedLength) && parsedLength > MAX_AVATAR_BYTES) {
        loggers.auth.warn('Google avatar rejected due to declared size', {
          userId,
          bytes: parsedLength,
        });
        return null;
      }
    }

    const buffer = await readResponseBodyWithLimit(response, MAX_AVATAR_BYTES);
    if (buffer.byteLength === 0) {
      loggers.auth.warn('Google avatar rejected due to empty response body', { userId });
      return null;
    }

    const detectedMimeType = detectMimeType(buffer);
    if (!detectedMimeType || detectedMimeType !== declaredMimeType) {
      loggers.auth.warn('Google avatar rejected due to MIME/signature mismatch', {
        userId,
        declaredMimeType,
        detectedMimeType: detectedMimeType || 'unknown',
      });
      return null;
    }

    const filename = `google-avatar.${MIME_EXTENSION_MAP[detectedMimeType]}`;
    const file = new File([buffer as unknown as Uint8Array<ArrayBuffer>], filename, {
      type: detectedMimeType,
    });
    return await uploadAvatarToProcessor(userId, file);
  } catch (error) {
    loggers.auth.warn('Google avatar ingestion failed', {
      userId,
      host: getUrlHostname(pictureUrl) || 'unknown',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
