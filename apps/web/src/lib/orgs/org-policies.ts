/** The org Policies page (UI-7, canvas Policies): pure pieces. */

/**
 * Toggle `id` in an allowlist (POL-8, POL-11). null is Unrestricted: unchecking from it allows every
 * other catalog id explicitly. An empty list allows nothing. Catalog order first, then any ids the
 * catalog no longer lists, so a stored choice is never silently dropped.
 */
export function toggleAllowlist(list: readonly string[] | null, id: string, catalog: readonly string[]): string[] {
  const current = new Set(list ?? catalog);
  if (current.has(id)) current.delete(id);
  else current.add(id);
  const ordered = catalog.filter((c) => current.has(c));
  const extra = [...current].filter((c) => !catalog.includes(c)).sort();
  return [...ordered, ...extra];
}

export function allowlistLabel(list: readonly string[] | null, catalogSize: number): string {
  if (list === null) return 'Unrestricted';
  if (list.length === 0) return 'None allowed';
  return `${list.length} of ${catalogSize} allowed`;
}

const NOUNS: Record<string, [string, string]> = {
  publicShareLinks: ['existing share link', 'existing share links'],
  publishedPages: ['published page', 'published pages'],
  customDomains: ['custom domain', 'custom domains'],
  guests: ['guest', 'guests'],
  integrations: ['service connection', 'service connections'],
  publishedApps: ['published app', 'published apps'],
  persistentEnvironments: ['environment', 'environments'],
  crossDriveAgents: ['agent from another drive', 'agents from other drives'],
  agentsAutonomous: ['automation', 'automations'],
  models: ['agent using a model', 'agents using models'],
};

const phrase = (counts: Record<string, number | undefined>, verb: string): string[] =>
  Object.entries(counts).flatMap(([kind, n]) => {
    if (!n) return [];
    const [one, many] = NOUNS[kind] ?? [kind, kind];
    return [`${n} ${n === 1 ? one : many} ${verb}`];
  });

/** POL-1: what a policy change did to existing things (from the PATCH response). */
export function policyChangeSummary(result: {
  suspended: Record<string, number | undefined>;
  restored: Record<string, number | undefined>;
  blocked: Record<string, number | undefined>;
}): string {
  const changed = [...phrase(result.suspended, 'suspended'), ...phrase(result.restored, 'restored')];
  const blocked = phrase(result.blocked, 'now blocked');
  const parts = ['Saved.'];
  if (changed.length > 0) parts.push(`${changed.join(', ')}.`);
  if (blocked.length > 0) parts.push(`${blocked.join(', ')}.`);
  return parts.join(' ');
}
