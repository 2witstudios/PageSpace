/** Joins the truthy class fragments into one class list. */
export const cn = (
  ...fragments: readonly (string | false | null | undefined)[]
): string => fragments.filter(Boolean).join(' ');
