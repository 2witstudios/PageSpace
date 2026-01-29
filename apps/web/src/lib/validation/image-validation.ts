/**
 * Image Validation Utilities - Zero Trust Validation
 *
 * Server-side validation for image attachments. Never trust client-declared
 * MIME types - always verify against actual content magic bytes.
 */

export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * Magic byte signatures for each allowed image type.
 * These are the first bytes of valid image files.
 */
const MAGIC_BYTES: Record<AllowedImageType, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/gif': [0x47, 0x49, 0x46], // "GIF"
  'image/webp': [0x52, 0x49, 0x46, 0x46], // "RIFF" header
};

/**
 * WebP requires additional validation - after RIFF header,
 * bytes 8-11 should be "WEBP"
 */
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface ExtractedDataUrl {
  mimeType: string;
  base64Data: string;
}

/**
 * Check if a MIME type is in the allowed list.
 * Strict matching - no case insensitivity.
 */
export const isAllowedImageType = (type: string): type is AllowedImageType => {
  return ALLOWED_IMAGE_TYPES.includes(type as AllowedImageType);
};

/**
 * Extract MIME type and base64 content from a data URL.
 * Returns null if the format is invalid.
 */
export const extractBase64DataUrl = (dataUrl: string): ExtractedDataUrl | null => {
  if (!dataUrl || typeof dataUrl !== 'string') {
    return null;
  }

  // Match: data:MIME;base64,CONTENT
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  const [, mimeType, base64Data] = match;
  if (!mimeType || !base64Data) {
    return null;
  }

  return { mimeType, base64Data };
};

/**
 * Decode base64 to bytes and validate magic signature.
 * Returns false for invalid base64 or mismatched signatures.
 */
export const validateMagicBytes = (
  base64Data: string,
  expectedType: AllowedImageType
): boolean => {
  if (!base64Data || !isAllowedImageType(expectedType)) {
    return false;
  }

  const expectedMagic = MAGIC_BYTES[expectedType];
  if (!expectedMagic) {
    return false;
  }

  try {
    // Decode base64 to binary
    const binaryString = atob(base64Data);
    if (binaryString.length < expectedMagic.length) {
      return false;
    }

    // Check magic bytes
    for (let i = 0; i < expectedMagic.length; i++) {
      if (binaryString.charCodeAt(i) !== expectedMagic[i]) {
        return false;
      }
    }

    // WebP needs additional check for "WEBP" at offset 8
    if (expectedType === 'image/webp') {
      if (binaryString.length < 12) {
        return false;
      }
      for (let i = 0; i < WEBP_SIGNATURE.length; i++) {
        if (binaryString.charCodeAt(8 + i) !== WEBP_SIGNATURE[i]) {
          return false;
        }
      }
    }

    return true;
  } catch {
    // Invalid base64
    return false;
  }
};

/**
 * Full validation of an image attachment.
 * Checks:
 * 1. Declared type is in allowlist
 * 2. Data URL format is valid
 * 3. Data URL MIME matches declared type
 * 4. Magic bytes match declared type
 */
export const validateImageAttachment = (attachment: {
  name: string;
  type: string;
  data: string;
}): ValidationResult => {
  const { name, type, data } = attachment;

  // 1. Check declared type is allowed
  if (!isAllowedImageType(type)) {
    return {
      valid: false,
      error: `File type "${type}" is not allowed for "${name}"`,
    };
  }

  // 2. Extract and validate data URL format
  const extracted = extractBase64DataUrl(data);
  if (!extracted) {
    return {
      valid: false,
      error: `Invalid data URL format for "${name}"`,
    };
  }

  // 3. Check data URL MIME matches declared type
  if (extracted.mimeType !== type) {
    return {
      valid: false,
      error: `MIME type mismatch for "${name}": declared "${type}" but data URL contains "${extracted.mimeType}"`,
    };
  }

  // 4. Validate magic bytes match declared type
  if (!validateMagicBytes(extracted.base64Data, type)) {
    return {
      valid: false,
      error: `Invalid magic bytes for "${name}": content does not match declared type "${type}"`,
    };
  }

  return { valid: true };
};
