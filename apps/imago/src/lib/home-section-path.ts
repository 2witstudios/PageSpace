/** The cross-drive views the account once held, now Home's own sections (ADR 0007 D4, amended). */
export type HomeSection = 'tasks' | 'calendar' | 'activity' | 'agents' | 'messages';

/** A Next.js page's resolved search params. */
export type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Where an old /account/<section> link lands on Home, its query (a date, a view, filters) kept: a tool's screen, or the section's pane. */
export const homeSectionPath = (homeDriveId: string, section: HomeSection, searchParams: SearchParams): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const each of typeof value === 'string' ? [value] : value ?? []) query.append(key, each);
  }
  const search = query.toString();
  // A tool's screen is the object it opens (stage.ts toolViewSegment); Tasks and Messages land on
  // their pane, and the Console on its own address, where a ?workspace= opens the session.
  const screen = section === 'tasks' || section === 'messages' || section === 'agents' ? section : `${section}/view`;
  return `/${encodeURIComponent(homeDriveId)}/${screen}${search ? `?${search}` : ''}`;
};
