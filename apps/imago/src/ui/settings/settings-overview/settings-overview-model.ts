// The drive settings overview (C-Settings-Index): its link rows and the live state hint each
// one shows. Every hint is read from an apps/web answer; when an answer is missing or not what
// the route promises, the hint is left out rather than guessed. Org, wallet and General
// visibility hints wait for their APIs (PR #2871) and are not drawn here.

export type HintTone = 'ok' | 'warn' | 'none';

export type OverviewRow = {
  readonly id: 'general' | 'roles' | 'integrations' | 'commands' | 'context' | 'backups' | 'domains' | 'danger';
  readonly title: string;
  readonly description: string;
  /** Root-relative to the drive, as the nav pane builds them: `/<driveId>/settings/...`. */
  readonly href: string;
  readonly state: string | null;
  readonly tone: HintTone;
  readonly danger: boolean;
};

export type OverviewGroup = { readonly label: string; readonly rows: readonly OverviewRow[] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const plural = (count: number, one: string, many: string): string => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** Commands in this drive and how many are switched off, from apps/web's /api/commands list. */
export type CommandsHint = { readonly total: number; readonly off: number };

export const commandsHintOf = (body: unknown, driveId: string): CommandsHint | null => {
  if (!isRecord(body) || !Array.isArray(body.commands)) return null;
  const own = body.commands.filter(
    (command): command is Readonly<Record<string, unknown>> => isRecord(command) && command.driveId === driveId,
  );
  return { total: own.length, off: own.filter((command) => command.enabled === false).length };
};

export type RolesHint = { readonly names: readonly { readonly name: string; readonly isDefault: boolean }[] };

/** Custom roles from GET /api/drives/[driveId]/roles, the default one flagged. */
export const rolesHintOf = (body: unknown): RolesHint | null => {
  if (!isRecord(body) || !Array.isArray(body.roles)) return null;
  const names = body.roles.flatMap((role) =>
    isRecord(role) && typeof role.name === 'string' ? [{ name: role.name, isDefault: role.isDefault === true }] : [],
  );
  return { names };
};

export type IntegrationsHint = { readonly connected: number; readonly expired: readonly string[] };

/** Connections from GET /api/drives/[driveId]/integrations; an expired one names itself. */
export const integrationsHintOf = (body: unknown): IntegrationsHint | null => {
  if (!isRecord(body) || !Array.isArray(body.connections)) return null;
  const expired: string[] = [];
  for (const connection of body.connections) {
    if (!isRecord(connection) || typeof connection.name !== 'string') continue;
    if (connection.status === 'expired') expired.push(connection.name);
  }
  return { connected: body.connections.length, expired };
};

export type DomainsHint = { readonly live: number; readonly waitingOnDns: number; readonly failed: number };

/** Custom domains from GET /api/drives/[driveId]/domains (the list the settings screen reads). */
export const domainsHintOf = (body: unknown): DomainsHint | null => {
  if (!isRecord(body) || !Array.isArray(body.domains)) return null;
  let live = 0;
  let waitingOnDns = 0;
  let failed = 0;
  for (const domain of body.domains) {
    if (!isRecord(domain)) continue;
    if (domain.status === 'active') live += 1;
    else if (domain.status === 'pending') waitingOnDns += 1;
    else if (domain.status === 'dns_failed' || domain.status === 'cert_failed' || domain.status === 'failed') failed += 1;
  }
  return { live, waitingOnDns, failed };
};

export type BackupsHint = {
  readonly enabled: boolean;
  readonly frequency: string;
  readonly lastRunAt: string | null;
};

/** The backup schedule from GET /api/drives/[driveId]/backups/schedule. */
export const backupsHintOf = (body: unknown): BackupsHint | null => {
  if (!isRecord(body) || typeof body.enabled !== 'boolean' || typeof body.frequency !== 'string') return null;
  return {
    enabled: body.enabled,
    frequency: body.frequency,
    lastRunAt: typeof body.lastRunAt === 'string' ? body.lastRunAt : null,
  };
};

/** Everything the overview hints need. An absent key means that answer has not arrived or was not asked for. */
export type OverviewHints = {
  readonly roles?: RolesHint | null;
  readonly integrations?: IntegrationsHint | null;
  readonly commands?: CommandsHint | null;
  /** The drive's `drivePrompt` length, or null when the drive has none. */
  readonly contextLength?: number | null;
  readonly backups?: BackupsHint | null;
  readonly domains?: DomainsHint | null;
};

const rolesState = (hint: RolesHint | null | undefined): string | null => {
  if (hint === null || hint === undefined) return null;
  if (hint.names.length === 0) return 'No custom roles';
  return hint.names.map((role) => (role.isDefault ? `${role.name} (default)` : role.name)).join(', ');
};

const integrationsState = (hint: IntegrationsHint | null | undefined): Pick<OverviewRow, 'state' | 'tone'> | null => {
  if (hint === null || hint === undefined) return null;
  const first = hint.expired[0];
  if (first !== undefined) return { state: `${first} expired`, tone: 'warn' };
  return { state: hint.connected === 0 ? 'None connected' : `${hint.connected} connected`, tone: 'none' };
};

const commandsState = (hint: CommandsHint | null | undefined): string | null => {
  if (hint === null || hint === undefined) return null;
  if (hint.total === 0) return 'No commands yet';
  return hint.off > 0 ? `${plural(hint.total, 'command', 'commands')} · ${hint.off} off` : plural(hint.total, 'command', 'commands');
};

const contextState = (length: number | null | undefined): string | null => {
  if (length === null || length === undefined) return null;
  return `${length.toLocaleString('en-US')} / 10,000 chars`;
};

const backupsState = (hint: BackupsHint | null | undefined): Pick<OverviewRow, 'state' | 'tone'> | null => {
  if (hint === null || hint === undefined) return null;
  if (!hint.enabled) return { state: 'Off', tone: 'none' };
  const frequency = hint.frequency.charAt(0).toUpperCase() + hint.frequency.slice(1);
  if (hint.lastRunAt === null) return { state: frequency, tone: 'ok' };
  const last = new Date(hint.lastRunAt);
  if (Number.isNaN(last.getTime())) return { state: frequency, tone: 'ok' };
  const day = last.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { state: `${frequency} · last ${day}`, tone: 'ok' };
};

const domainsState = (hint: DomainsHint | null | undefined): Pick<OverviewRow, 'state' | 'tone'> | null => {
  if (hint === null || hint === undefined) return null;
  const parts: string[] = [];
  if (hint.live > 0) parts.push(`${hint.live} live`);
  if (hint.waitingOnDns > 0) parts.push(`${hint.waitingOnDns} waiting on DNS`);
  if (hint.failed > 0) parts.push(`${hint.failed} failed`);
  if (parts.length === 0) return { state: 'No custom domains', tone: 'none' };
  return { state: parts.join(' · '), tone: hint.waitingOnDns > 0 || hint.failed > 0 ? 'warn' : 'ok' };
};

/**
 * The overview's groups in the SPEC's order. A plain member sees only Commands; Context,
 * Members & roles, Integrations, Backups and Domains are owner/admin screens, and Danger zone
 * is the owner's alone, the same gating the retained settings index applied.
 */
export const overviewGroups = ({
  driveId,
  canManage,
  isOwner,
  hints,
}: {
  readonly driveId: string;
  readonly canManage: boolean;
  readonly isOwner: boolean;
  readonly hints: OverviewHints;
}): readonly OverviewGroup[] => {
  const base = `/${encodeURIComponent(driveId)}/settings`;
  const row = (
    id: OverviewRow['id'],
    title: string,
    description: string,
    state: { state: string | null; tone: HintTone } | null,
    danger = false,
  ): OverviewRow => ({
    id,
    title,
    description,
    href: id === 'general' ? `${base}/general` : `${base}/${id}`,
    state: state?.state ?? null,
    tone: state?.tone ?? 'none',
    danger,
  });
  const integrations = integrationsState(hints.integrations);
  const backups = backupsState(hints.backups);
  const domains = domainsState(hints.domains);
  const commands = commandsState(hints.commands);
  const roles = rolesState(hints.roles);
  const context = contextState(hints.contextLength);

  const groups: OverviewGroup[] = [];
  if (canManage) {
    groups.push({
      label: 'Drive',
      rows: [
        // The visibility hint waits for the org API (PR #2871); General keeps no state until then.
        row('general', 'General', 'Drive name, home page and members', null),
        row('roles', 'Members & roles', 'Custom roles and permissions', roles === null ? null : { state: roles, tone: 'none' }),
      ],
    });
  }
  groups.push({
    label: 'AI & connections',
    rows: [
      ...(canManage ? [row('integrations', 'Integrations', 'External services and API connections', integrations)] : []),
      row('commands', 'Commands', 'Slash commands for everyone in this drive', commands === null ? null : { state: commands, tone: 'none' }),
      ...(canManage ? [row('context', 'Context', 'Workspace memory for AI', context === null ? null : { state: context, tone: 'none' })] : []),
    ],
  });
  if (canManage) {
    groups.push({
      label: 'Data & publishing',
      rows: [
        row('backups', 'Backups', 'Snapshots of pages, members, and roles', backups),
        row('domains', 'Domains', 'Custom domains for your published site', domains),
      ],
    });
  }
  if (isOwner) {
    groups.push({
      label: 'Administration',
      rows: [row('danger', 'Danger zone', 'Delete this drive', { state: 'Drive lead only', tone: 'none' }, true)],
    });
  }
  return groups;
};
