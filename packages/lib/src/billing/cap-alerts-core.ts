/**
 * cap-alerts-core — which per-consumer cap alerts are due and what the funder reads (Spec WAL-7,
 * D20.6: alerts to the funder at 80% and 100%). Pure; the shell (wallet-cap-alerts) sends each
 * due alert at most once per threshold, window and period.
 */
import { formatCreditCount } from './money-model';
import { capThresholdsReached, type CapAlertThreshold, type CapWindow } from './wallet-core';

export interface CapWindowSpend {
  window: CapWindow;
  /** The cap in force for the window, whole cents; null = no cap there. */
  capCents: number | null;
  /** The consumer's settled spend in the window, whole cents. */
  spentCents: number;
}

export interface DueCapAlert {
  window: CapWindow;
  threshold: CapAlertThreshold;
}

/** Every threshold reached in every window, daily first. */
export function capAlertsDue(windows: CapWindowSpend[]): DueCapAlert[] {
  return windows.flatMap((w) => capThresholdsReached({ capCents: w.capCents, spentCents: w.spentCents }).map((threshold) => ({ window: w.window, threshold })));
}

/** The in-app alert's copy: credit counts through the one money model, never a dollar sign. */
export function capAlertCopy(input: {
  threshold: CapAlertThreshold;
  window: CapWindow;
  consumerName: string;
  placeName: string;
  spentCents: number;
  capCents: number;
}): { title: string; message: string } {
  const amounts = `${formatCreditCount(input.spentCents)} of ${formatCreditCount(input.capCents)} credits`;
  if (input.threshold === 100) {
    return {
      title: 'A spending cap was reached',
      message: `${input.consumerName} has reached their ${input.window} cap in ${input.placeName}: ${amounts}. Their calls on this wallet are refused until the cap resets or is raised.`,
    };
  }
  return {
    title: `A spending cap is at ${input.threshold}%`,
    message: `${input.consumerName} has used ${input.threshold}% of their ${input.window} cap in ${input.placeName}: ${amounts}.`,
  };
}
