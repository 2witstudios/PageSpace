/**
 * Server-side validation for image/file parts in UIMessages.
 * Enforces count limits, size limits, and delegates content validation
 * to the zero-trust image-validation module.
 */

import type { UIMessage } from 'ai';
import {
  validateImageAttachment,
  isAllowedImageType,
  extractBase64DataUrl,
} from '@/lib/validation/image-validation';

const MAX_FILE_PARTS_PER_MESSAGE = 5;
const MAX_DATA_URL_LENGTH = 4 * 1024 * 1024; // 4MB per data URL

export interface FilePartValidationResult {
  valid: boolean;
  error?: string;
  filePartCount: number;
}

interface FilePart {
  type: 'file';
  url: string;
  mediaType?: string;
  filename?: string;
}

/**
 * Extract file parts from a UIMessage.
 */
function extractFileParts(message: UIMessage): FilePart[] {
  if (!message.parts || !Array.isArray(message.parts)) return [];

  return message.parts
    .filter(
      (part) =>
        part !== null &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'file'
    )
    .map((part) => part as unknown as FilePart);
}

/**
 * Check whether a UIMessage contains any file parts.
 */
export function hasFileParts(message: UIMessage): boolean {
  return extractFileParts(message).length > 0;
}

/**
 * Validate all file parts in a user message.
 * Checks:
 * 1. File part count limit
 * 2. Per-image data URL size limit
 * 3. MIME type allowlist + data URL format + magic byte verification
 */
export function validateUserMessageFileParts(
  message: UIMessage
): FilePartValidationResult {
  const fileParts = extractFileParts(message);

  if (fileParts.length === 0) {
    return { valid: true, filePartCount: 0 };
  }

  // 1. Count limit
  if (fileParts.length > MAX_FILE_PARTS_PER_MESSAGE) {
    return {
      valid: false,
      error: `Too many image attachments: ${fileParts.length} (max ${MAX_FILE_PARTS_PER_MESSAGE})`,
      filePartCount: fileParts.length,
    };
  }

  // 2 & 3. Validate each file part
  for (let i = 0; i < fileParts.length; i++) {
    const part = fileParts[i];
    const url = part.url;
    const filename = part.filename || `image-${i + 1}`;

    // Size check
    if (url.length > MAX_DATA_URL_LENGTH) {
      return {
        valid: false,
        error: `Image "${filename}" exceeds the 4MB size limit`,
        filePartCount: fileParts.length,
      };
    }

    // Must be a data URL
    if (!url.startsWith('data:')) {
      return {
        valid: false,
        error: `Image "${filename}" is not a valid data URL`,
        filePartCount: fileParts.length,
      };
    }

    // Extract MIME from data URL for cross-check
    const extracted = extractBase64DataUrl(url);
    if (!extracted) {
      return {
        valid: false,
        error: `Invalid data URL format for "${filename}"`,
        filePartCount: fileParts.length,
      };
    }

    // Use the data URL's MIME as the authoritative type
    const effectiveType = extracted.mimeType;

    if (!isAllowedImageType(effectiveType)) {
      return {
        valid: false,
        error: `File type "${effectiveType}" is not allowed for "${filename}"`,
        filePartCount: fileParts.length,
      };
    }

    // Full validation: allowlist + format + MIME cross-check + magic bytes
    const validation = validateImageAttachment({
      name: filename,
      type: effectiveType,
      data: url,
    });

    if (!validation.valid) {
      return {
        valid: false,
        error: validation.error,
        filePartCount: fileParts.length,
      };
    }
  }

  return { valid: true, filePartCount: fileParts.length };
}
