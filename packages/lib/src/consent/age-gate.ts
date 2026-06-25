/**
 * Pure age-gate logic (GDPR Art 8).
 *
 * Art 8 sets a default minimum age of 16 for consent to information-society services
 * (member states may lower to 13). We default to 16 and fail closed on bad input.
 *
 * Client-safe: no Node.js dependencies.
 */

/** GDPR Art 8 default minimum age. */
export const DEFAULT_MINIMUM_AGE = 16;

function toValidDate(value: Date | string | undefined | null): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Whole-years age at the reference date, or null if either date is invalid.
 * The current year's birthday does not count until it has passed.
 */
export function computeAge(
  dateOfBirth: Date | string | undefined | null,
  reference: Date | string,
): number | null {
  const dob = toValidDate(dateOfBirth);
  const ref = toValidDate(reference);
  if (dob === null || ref === null) return null;

  let age = ref.getUTCFullYear() - dob.getUTCFullYear();
  const refMonth = ref.getUTCMonth();
  const dobMonth = dob.getUTCMonth();
  if (refMonth < dobMonth || (refMonth === dobMonth && ref.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * True only when the computed age is at least the minimum. Fails closed (false) for a
 * malformed or absent date of birth.
 */
export function meetsMinimumAge(
  dateOfBirth: Date | string | undefined | null,
  reference: Date | string,
  minimumAge: number = DEFAULT_MINIMUM_AGE,
): boolean {
  const age = computeAge(dateOfBirth, reference);
  if (age === null) return false;
  return age >= minimumAge;
}
