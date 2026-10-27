import { Mark, markInitial, type MarkProps } from '@/retained/components/marks/Mark';

export type OrgMarkProps = Omit<MarkProps, 'color' | 'fallbackLabel'>;

/** The first user-perceived character of an org's name (see markInitial). */
export const orgInitial = markInitial;

/**
 * An organization's mark (canvas .orgmark): its avatar, or its initial on the primary color. Semantic
 * tokens only, so it holds in light and dark. Named by the org unless `decorative`.
 */
export function OrgMark(props: OrgMarkProps) {
  return <Mark {...props} fallbackLabel="Organization" />;
}
