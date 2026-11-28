/** Shared display formatting for the admin console. */

import { dollarsFromCents } from '@pagespace/lib/billing/money-model';

export function usd(cents: number): string {
  return dollarsFromCents(cents).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function pct(value: number | null, digits = 1): string {
  return value == null ? 'n/a' : `${value.toFixed(digits)}%`;
}

export function num(value: number): string {
  return value.toLocaleString('en-US');
}
