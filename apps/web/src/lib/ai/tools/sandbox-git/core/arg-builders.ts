/**
 * Pure argv-construction primitives for the sandbox git toolkit. These replace
 * the 120+ ad-hoc `...(x ? [flag, x] : [])` spreads and 9 `list.join(',')` copies
 * scattered across the tools, so argv arrays are built from named data rather
 * than re-derived by hand. No effects, no imports — every branch is tested in
 * `__tests__/arg-builders.test.ts`.
 */

/** `flag <value>` when the value is truthy (empty string / undefined omit it). */
export function optArg(flag: string, value: string | undefined): string[] {
  return value ? [flag, value] : [];
}

/** A boolean flag, emitted only when the condition holds. */
export function optFlag(flag: string, cond: boolean | undefined): string[] {
  return cond ? [flag] : [];
}

/** `flag a,b,c` when the list is non-empty — the 9 `list.join(',')` sites. */
export function csvFlag(flag: string, list: readonly string[] | undefined): string[] {
  return list && list.length > 0 ? [flag, list.join(',')] : [];
}

/** `--json field1,field2` built from a field list. */
export function buildGhJsonFlag(fields: readonly string[]): string[] {
  return ['--json', fields.join(',')];
}

/**
 * A `gh api` `-f key=value` (or `-F key=value` for raw/typed) pair. The value is
 * kept a SINGLE argv element even if it contains `=` or a newline — this is the
 * injection containment for the `gh api -f` seam, where a split value could
 * smuggle extra fields into the request.
 */
export function buildApiKvArgs(flag: '-f' | '-F', key: string, value: string | number): string[] {
  return [flag, `${key}=${value}`];
}
