/**
 * env-parse — strict readers for billing env overrides, shared by money-model
 * and credit-pricing. A typo'd value falls back to the documented default rather
 * than silently parsing to something else.
 */

/** The env source; injectable so a caller can evaluate a flag against a supplied env. */
export type EnvSource = Record<string, string | undefined>;

/** Parse an unsigned-integer env override; fall back on absence or any non-digit junk. */
export function envInt(name: string, fallback: number, env: EnvSource = process.env): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  // Strict: only an unsigned integer literal overrides the default. Rejects
  // trailing junk ("100abc"), decimals ("1.5"), and signs so a typo'd billing
  // env var falls back to the safe default instead of silently parsing.
  if (!/^\d+$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

export function envBool(name: string, fallback: boolean, env: EnvSource = process.env): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return fallback; // unrecognized value -> safe default
}

/** Parse a non-negative float env override; fall back to `fallback` on absence/garbage. */
export function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
