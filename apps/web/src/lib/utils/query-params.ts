interface ParseBoundedIntParamOptions {
  defaultValue: number;
  min?: number;
  max?: number;
}

/**
 * Parse a numeric query param safely with explicit bounds.
 * Falls back to the bounded default value when the input is missing or invalid.
 */
export function parseBoundedIntParam(
  rawValue: string | null,
  options: ParseBoundedIntParamOptions
): number {
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const boundedDefault = Math.min(max, Math.max(min, options.defaultValue));

  if (!rawValue) {
    return boundedDefault;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return boundedDefault;
  }

  return Math.min(max, Math.max(min, parsed));
}
