interface ParseBoundedIntParamOptions {
  defaultValue: number;
  min?: number;
  max?: number;
}

export function parseBoundedIntParam(
  rawValue: string | null,
  options: ParseBoundedIntParamOptions
): number {
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const boundedDefault = Math.min(max, Math.max(min, options.defaultValue));

  if (!rawValue) return boundedDefault;

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return boundedDefault;

  return Math.min(max, Math.max(min, parsed));
}
