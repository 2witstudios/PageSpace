/**
 * UI-12 test helper: a dollar figure stated AS a credit amount. Shared by the plan-facts unit test
 * and the marketing pricing-page render test (imported by relative path) so the two cannot drift.
 *
 * Catches "$" with only a figure and an optional joiner between it and "credits" ("$1,500 credits",
 * "$1.5k credits", "$15 of credits", "$15 in credits", "$15 worth of credits"), and "credits"
 * followed by a "$" figure ("credits: $15", "credits worth $15", "1,500 credits ($15)"). A purchase
 * rate ("1,000 credits per $10") is real money for a top-up and is NOT a match.
 */
export const DOLLAR_BESIDE_CREDITS =
  /\$\s*[\d,.]*\s*[km]?\s*(?:(?:worth\s+)?(?:of|in)\s+|worth\s+)?credits\b|\bcredits\s*(?:[:(]\s*|worth\s+(?:of\s+)?|of\s+)?\$/i;
