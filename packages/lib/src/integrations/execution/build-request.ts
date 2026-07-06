/**
 * Pure Request Building Functions
 *
 * Builds HTTP requests from templates and input values.
 * These are PURE functions - no side effects, deterministic output.
 */

import type { HttpExecutionConfig, HttpRequest, ParameterRef } from '../types';

// The WHATWG URL Standard's path state treats these literal (ASCII
// case-insensitive) strings as single-/double-dot segments — and normalizes
// them — even though they aren't the literal "." / "..". A segment check
// that only compares against "." / ".." disagrees with what `URL.pathname =`
// actually normalizes, so it can be bypassed with e.g. "%2e%2e". Backslash is
// also treated as a path separator by the URL parser for special schemes
// (http/https among them), so it must be rejected outright rather than
// split on — it isn't a legitimate character in a GitHub API path segment.
const SINGLE_DOT_SEGMENT = /^(\.|%2e)$/i;
const DOUBLE_DOT_SEGMENT = /^(\.\.|\.%2e|%2e\.|%2e%2e)$/i;
const isDotSegment = (segment: string): boolean =>
  SINGLE_DOT_SEGMENT.test(segment) || DOUBLE_DOT_SEGMENT.test(segment);

/**
 * A raw path param may contain literal "/" (e.g. a nested file path), but
 * every segment must still be non-empty and not a dot-segment, otherwise a
 * value like "../../other-repo/contents/x" (or its percent-encoded
 * equivalent) walks the built URL out of the intended path prefix once
 * assigned to `URL.pathname` (which normalizes dot-segments).
 */
const assertNoTraversal = ({ key, value }: { key: string; value: string }): string => {
  if (value.includes('\\')) {
    throw new Error(`Path parameter "${key}" must not contain "\\"`);
  }
  if (value.split('/').some((segment) => segment === '' || isDotSegment(segment))) {
    throw new Error(`Path parameter "${key}" must not contain empty or "."/".." segments`);
  }
  return value;
};

/**
 * A plain identifier param (owner, repo, ref, sha, ...) should never carry a
 * path separator or a dot-segment; allowing either lets it reshape the URL
 * structure rather than fill a single path segment.
 */
const assertPlainIdentifier = ({ key, value }: { key: string; value: string }): string => {
  if (value.includes('/') || value.includes('\\') || isDotSegment(value)) {
    throw new Error(`Path parameter "${key}" must not contain "/" or be "." or ".."`);
  }
  return value;
};

/**
 * Interpolate path template with input values.
 * Replaces {param} placeholders with corresponding input values.
 * Params listed in `rawPathParams` may contain literal "/" (still traversal-checked);
 * every other param must be a plain identifier with no "/" or "."/".." segments.
 */
export const interpolatePath = ({
  template,
  input,
  rawPathParams = [],
}: {
  template: string;
  input: Record<string, unknown>;
  rawPathParams?: string[];
}): string => {
  const rawKeys = new Set(rawPathParams);
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = input[key];
    if (value === undefined) return '';
    const str = String(value);
    return rawKeys.has(key)
      ? assertNoTraversal({ key, value: str })
      : assertPlainIdentifier({ key, value: str });
  });
};

/**
 * Resolve a value that may be a static string or a parameter reference.
 */
export const resolveValue = (
  value: string | ParameterRef,
  input: Record<string, unknown>
): unknown => {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && '$param' in value) {
    const rawValue = input[value.$param] !== undefined
      ? input[value.$param]
      : value.default;

    if (rawValue === undefined) {
      return undefined;
    }

    if (value.transform) {
      switch (value.transform) {
        case 'string':
          return String(rawValue);
        case 'number':
          return Number(rawValue);
        case 'boolean':
          return rawValue === 'true' || rawValue === true;
        case 'json':
          if (typeof rawValue === 'string') {
            try {
              return JSON.parse(rawValue);
            } catch {
              return rawValue;
            }
          }
          return rawValue;
      }
    }

    return rawValue;
  }

  return value;
};

/**
 * Deep-resolve a body template, replacing all $param references.
 */
export const resolveBody = (
  template: unknown,
  input: Record<string, unknown>
): unknown => {
  if (template === null || template === undefined) {
    return template;
  }

  if (Array.isArray(template)) {
    return template.map((item) => resolveBody(item, input));
  }

  if (typeof template === 'object') {
    // Check if it's a parameter reference
    if ('$param' in template) {
      return resolveValue(template as ParameterRef, input);
    }

    // Recursively resolve object properties
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = resolveBody(value, input);
    }
    return result;
  }

  return template;
};

/**
 * Encode body based on encoding type.
 */
const encodeBody = (
  body: Record<string, unknown>,
  encoding: 'json' | 'form' | 'multipart'
): string => {
  switch (encoding) {
    case 'json':
      return JSON.stringify(body);

    case 'form': {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      }
      return params.toString();
    }

    case 'multipart':
      // Multipart encoding would need FormData, returning JSON for now
      return JSON.stringify(body);
  }
};

/**
 * Build a complete HTTP request from config and input.
 */
export const buildHttpRequest = (
  config: HttpExecutionConfig,
  input: Record<string, unknown>,
  baseUrl: string
): HttpRequest => {
  // Build path
  const path = interpolatePath({
    template: config.pathTemplate,
    input,
    rawPathParams: config.rawPathParams,
  });

  // Build URL - properly merge base path with request path
  const baseUrlObj = new URL(baseUrl);
  const basePath = baseUrlObj.pathname.endsWith('/')
    ? baseUrlObj.pathname.slice(0, -1)
    : baseUrlObj.pathname;
  const fullPath = path.startsWith('/')
    ? basePath + path
    : basePath + '/' + path;
  baseUrlObj.pathname = fullPath;
  const url = baseUrlObj;

  // Add query params
  if (config.queryParams) {
    for (const [key, value] of Object.entries(config.queryParams)) {
      const resolved = resolveValue(value, input);
      if (resolved !== undefined && resolved !== null) {
        url.searchParams.set(key, String(resolved));
      }
    }
  }

  // Build headers
  const headers: Record<string, string> = {};
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      const resolved = resolveValue(value, input);
      if (resolved !== undefined && resolved !== null) {
        headers[key] = String(resolved);
      }
    }
  }

  // Build body (only for non-GET requests)
  let body: string | undefined;
  if (config.method !== 'GET' && config.bodyTemplate) {
    const resolvedBody = resolveBody(config.bodyTemplate, input) as Record<string, unknown>;
    body = encodeBody(resolvedBody, config.bodyEncoding ?? 'json');
  }

  return {
    url: url.toString(),
    method: config.method,
    headers,
    body,
  };
};
