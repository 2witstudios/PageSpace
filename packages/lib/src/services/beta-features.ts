export const BETA_FEATURES = {
  CODEX: 'codex',
} as const;

export type BetaFeature = (typeof BETA_FEATURES)[keyof typeof BETA_FEATURES];

export function hasBetaFeature(
  user: { betaFeatures: string[] | null },
  feature: BetaFeature,
): boolean {
  return user.betaFeatures?.includes(feature) ?? false;
}
