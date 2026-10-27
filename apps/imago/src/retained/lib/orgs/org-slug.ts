/**
 * The org URL slug: its one pattern (the /api/orgs schemas validate with it) and the preview the
 * create dialog derives from a name. Pure, client-safe.
 */

/** Lowercase letters, digits and inner hyphens, 1-48 characters; it becomes part of org URLs. */
export const ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const ORG_SLUG_MAX_LENGTH = 48;

export const isValidOrgSlug = (slug: string): boolean => ORG_SLUG_PATTERN.test(slug);

/** A slug preview for `name`, or '' when the name has no letters or digits. */
export function slugFromOrgName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ORG_SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}
