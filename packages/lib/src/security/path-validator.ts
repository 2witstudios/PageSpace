/**
 * Path Validator for Traversal Prevention
 *
 * Provides utilities to validate file paths before accessing the filesystem,
 * preventing path traversal attacks.
 *
 * Key protections:
 * - Blocks directory traversal (../ patterns)
 * - Blocks URL-encoded traversal (%2e%2e%2f)
 * - Blocks double/triple encoded traversal (%252e%252e%252f)
 * - Blocks null byte injection (\x00)
 * - Blocks symlink escapes via realpath verification
 * - Blocks absolute paths when base directory specified
 */

import { resolve, relative, isAbsolute, dirname, sep } from 'path';
import { realpath, stat } from 'fs/promises';

export interface PathValidationResult {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
}

/**
 * Maximum number of URI decoding iterations to prevent infinite loops
 * from deeply nested encodings (potential attack vector)
 */
const MAX_DECODE_ITERATIONS = 5;

/**
 * Iteratively decode a path until stable or max iterations reached
 * Returns null if malformed encoding detected or max iterations exceeded
 */
function iterativelyDecode(input: string): string | null {
  let current = input;
  let previous: string;
  let iterations = 0;

  do {
    previous = current;
    try {
      current = decodeURIComponent(current);
    } catch {
      // URIError from malformed encoding - reject as potential attack
      return null;
    }
    iterations++;
  } while (current !== previous && iterations < MAX_DECODE_ITERATIONS);

  // If still changing after MAX_ITERATIONS, likely an attack - reject
  if (current !== previous) {
    return null;
  }

  return current;
}

/**
 * Remove null bytes from a string
 * Null bytes can be used to truncate paths in certain contexts
 */
function removeNullBytes(input: string): string {
  return input.replace(/\x00/g, '');
}

/**
 * Check if a path contains traversal patterns after normalization
 */
function containsTraversalPattern(pathSegment: string): boolean {
  // Check for .. segments (already decoded at this point)
  const segments = pathSegment.split(/[/\\]/);
  return segments.some(segment => segment === '..' || segment === '.');
}

/**
 * Check if a path is absolute on any platform (Unix or Windows)
 * This is needed because Node's isAbsolute() only checks for the current platform
 */
function isAbsoluteAnyPlatform(pathStr: string): boolean {
  // Unix absolute path
  if (pathStr.startsWith('/')) {
    return true;
  }
  // Windows drive letter (C:, D:, etc.)
  if (/^[a-zA-Z]:/.test(pathStr)) {
    return true;
  }
  // Windows UNC path (\\server\share)
  if (pathStr.startsWith('\\\\')) {
    return true;
  }
  return false;
}

/**
 * Resolve a path within a base directory, preventing traversal
 * Returns null if path would escape base directory
 *
 * SECURITY FEATURES:
 * - Decodes iteratively to prevent double/triple encoding bypasses
 *   like %252e%252e%252f -> %2e%2e%2f -> ../
 * - Removes null bytes that could truncate paths
 * - Verifies symlinks don't escape base directory
 * - Checks parent directories for non-existent paths
 *
 * @param base - The base directory that paths must stay within
 * @param userPath - The user-provided path to resolve
 * @returns The resolved absolute path, or null if validation fails
 */
export async function resolvePathWithin(
  base: string,
  userPath: string
): Promise<string | null> {
  // Validate inputs
  if (!base || typeof base !== 'string') {
    return null;
  }
  if (!userPath || typeof userPath !== 'string') {
    return null;
  }

  // CRITICAL: Decode iteratively until stable (prevents double-encoding attacks)
  const decoded = iterativelyDecode(userPath);
  if (decoded === null) {
    return null;
  }

  // Remove null bytes
  const sanitized = removeNullBytes(decoded);

  // Quick check for obvious traversal before path resolution
  if (containsTraversalPattern(sanitized)) {
    return null;
  }

  // Reject absolute paths in user input (must be relative to base)
  // Use cross-platform check to catch Windows paths on Unix systems
  if (isAbsolute(sanitized) || isAbsoluteAnyPlatform(sanitized)) {
    return null;
  }

  // Resolve paths to absolute
  const resolvedBase = resolve(base);
  const resolvedPath = resolve(resolvedBase, sanitized);

  // Verify path is within base using relative path check
  const relativePath = relative(resolvedBase, resolvedPath);

  // If relative path starts with '..' or is absolute, path escapes base
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }

  // Verify no symlink escape
  try {
    const realPath = await realpath(resolvedPath);
    const realBase = await realpath(resolvedBase);

    // The resolved real path must start with the real base path
    // Use sep to ensure we don't match partial directory names
    // e.g., /data/files-backup should not match /data/files
    if (!realPath.startsWith(realBase + sep) && realPath !== realBase) {
      return null;
    }
  } catch (error) {
    // Path doesn't exist yet - that's ok for new files
    // But verify parent exists and is within base
    const parent = dirname(resolvedPath);

    try {
      // Check if parent directory exists
      await stat(parent);
      const realParent = await realpath(parent);
      const realBase = await realpath(resolvedBase);

      // Parent must be within or equal to base
      if (!realParent.startsWith(realBase + sep) && realParent !== realBase) {
        return null;
      }
    } catch {
      // Parent doesn't exist - walk up to find first existing ancestor
      // and verify its realpath is within base (catches symlink escapes)
      const realBase = await realpath(resolvedBase);
      let ancestor = parent;

      // Walk up until we find an existing ancestor or reach base
      while (ancestor !== resolvedBase && ancestor !== dirname(ancestor)) {
        try {
          const realAncestor = await realpath(ancestor);
          // Existing ancestor must be within base
          if (!realAncestor.startsWith(realBase + sep) && realAncestor !== realBase) {
            return null;
          }
          // Found valid ancestor, path is safe
          break;
        } catch {
          // Ancestor doesn't exist, keep walking up
          ancestor = dirname(ancestor);
        }
      }

      // Final check: resolved path must be within base (string check)
      const parentRelative = relative(resolvedBase, parent);
      if (parentRelative.startsWith('..') || isAbsolute(parentRelative)) {
        return null;
      }
    }
  }

  return resolvedPath;
}

/**
 * Synchronous version for basic path validation without symlink checking
 * Use this only when async is not possible and symlink attacks are mitigated
 * by other means (e.g., path components are pre-validated identifiers)
 *
 * IMPORTANT: This version does NOT verify symlink escapes.
 * For full security, use the async resolvePathWithin function.
 *
 * @param base - The base directory that paths must stay within
 * @param segments - Path segments to resolve (each segment is validated)
 * @returns The resolved absolute path, or null if validation fails
 */
export function resolvePathWithinSync(
  base: string,
  ...segments: string[]
): string | null {
  // Validate base
  if (!base || typeof base !== 'string') {
    return null;
  }

  const resolvedBase = resolve(base);
  const sanitizedSegments: string[] = [];

  // Validate and sanitize each segment
  for (const segment of segments) {
    if (!segment || typeof segment !== 'string') {
      continue; // Skip empty segments
    }

    // Decode and sanitize each segment
    const decoded = iterativelyDecode(segment);
    if (decoded === null) {
      return null;
    }

    const sanitized = removeNullBytes(decoded);

    // Check for traversal in segment
    if (containsTraversalPattern(sanitized)) {
      return null;
    }

    // Reject absolute paths in segments
    // Use cross-platform check to catch Windows paths on Unix systems
    if (isAbsolute(sanitized) || isAbsoluteAnyPlatform(sanitized)) {
      return null;
    }

    sanitizedSegments.push(sanitized);
  }

  // Resolve all sanitized segments (not original - this ensures null bytes are removed)
  const targetPath = resolve(resolvedBase, ...sanitizedSegments);

  // Verify path is within base
  // Use trailing separator check to prevent partial matches
  const expectedPrefix = resolvedBase.endsWith(sep)
    ? resolvedBase
    : resolvedBase + sep;

  // Path must either equal base exactly or start with base + separator
  if (targetPath !== resolvedBase && !targetPath.startsWith(expectedPrefix)) {
    return null;
  }

  return targetPath;
}

/**
 * Validate that a path is safe for use as a filename
 * Returns sanitized filename or null if invalid
 *
 * @param filename - The filename to validate
 * @returns Sanitized filename or null if invalid
 */
export function validateFilename(filename: string): string | null {
  if (!filename || typeof filename !== 'string') {
    return null;
  }

  // Decode and sanitize
  const decoded = iterativelyDecode(filename);
  if (decoded === null) {
    return null;
  }

  const sanitized = removeNullBytes(decoded);

  // Reject if contains path separators
  if (sanitized.includes('/') || sanitized.includes('\\')) {
    return null;
  }

  // Reject traversal patterns
  if (sanitized === '.' || sanitized === '..') {
    return null;
  }

  // Reject empty after sanitization
  if (sanitized.trim().length === 0) {
    return null;
  }

  return sanitized;
}

/**
 * Check if a path would escape a base directory
 * Returns true if the path is safe, false if it would escape
 *
 * NOTE: This function does NOT verify symlink escapes.
 * For full security with symlink checking, use resolvePathWithin.
 *
 * @param base - The base directory
 * @param userPath - The user-provided path to check
 * @returns true if path is safe, false if it would escape
 */
export function isPathWithinBase(base: string, userPath: string): boolean {
  if (!base || !userPath) {
    return false;
  }

  // Decode and sanitize
  const decoded = iterativelyDecode(userPath);
  if (decoded === null) {
    return false;
  }

  const sanitized = removeNullBytes(decoded);

  // Check for traversal
  if (containsTraversalPattern(sanitized)) {
    return false;
  }

  // Reject absolute paths
  // Use cross-platform check to catch Windows paths on Unix systems
  if (isAbsolute(sanitized) || isAbsoluteAnyPlatform(sanitized)) {
    return false;
  }

  const resolvedBase = resolve(base);
  const resolvedPath = resolve(resolvedBase, sanitized);
  const relativePath = relative(resolvedBase, resolvedPath);

  return !relativePath.startsWith('..') && !isAbsolute(relativePath);
}
