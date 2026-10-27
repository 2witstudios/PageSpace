import type { Section } from '../stage/stage';

/**
 * A section reads either the drive in the URL or every drive the viewer can reach. The same pane
 * draws both: All drives is the drive's section with its drive filter lifted, and where the
 * section is a tree (Files, Tasks' lists) it lists the drives to pick from instead.
 */
export type SectionScope = 'drive' | 'all';

/** The sections whose head carries the scope switch. */
export const scopedSections = ['files', 'messages', 'tasks', 'calendar', 'agents', 'activity'] as const;

export type ScopedSection = (typeof scopedSections)[number];

export const hasScope = (section: Section): section is ScopedSection =>
  (scopedSections as readonly Section[]).includes(section);

/** The viewer's choice per section; a section never switched has none. */
export type SectionScopes = Readonly<Partial<Record<ScopedSection, SectionScope>>>;

export const NO_SCOPES: SectionScopes = {};

export const SECTION_SCOPES_KEY = 'imago:section-scopes';

/**
 * The sections whose All drives swaps the drive's tree (Files' pages, Tasks' lists) for the drives
 * to pick from. They open on the drive itself, even on Home, so a drive's own tree is never hidden
 * behind a choice the viewer has not made.
 */
const treeSections: readonly ScopedSection[] = ['files', 'tasks'];

/**
 * A section's scope: the viewer's choice, else every drive on Home (the dashboard, ADR 0007 D4)
 * for a section that only reads across drives, and the drive itself anywhere else.
 */
export const resolveScope = (scopes: SectionScopes, section: ScopedSection, isHome: boolean): SectionScope =>
  scopes[section] ?? (isHome && !treeSections.includes(section) ? 'all' : 'drive');

const isScope = (value: unknown): value is SectionScope => value === 'drive' || value === 'all';

/** What localStorage held; anything malformed is no choice. */
export const parseScopes = (raw: string | null): SectionScopes => {
  if (raw === null) return NO_SCOPES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return NO_SCOPES;
    const record = parsed as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      scopedSections.flatMap((section) => (isScope(record[section]) ? [[section, record[section]]] : [])),
    );
  } catch {
    return NO_SCOPES;
  }
};

export const serializeScopes = (scopes: SectionScopes): string => JSON.stringify(scopes);
