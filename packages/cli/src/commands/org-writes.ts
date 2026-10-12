/**
 * `pagespace orgs <verb>` — the organization WRITES and admin reads (Spec X-1, ORG-5). Each verb
 * is a thin projection over one `organizations.*` SDK operation, built on `verb.ts`: pure argv
 * parsing and rendering, `ctx.sdk` the only I/O edge. Destructive verbs (remove a member, leave,
 * revoke an invitation, delete an automation, remove a domain) need `--yes` or a TTY "y".
 *
 * The server decides, through the web's one org authorization function (requireOrgRole): the
 * same 404 for a non-member and 403 for a role too low that the web answers, the org's sign-in
 * policy applied to the key, and a drive-scoped key refused. Session-only acts are not verbs at
 * all: creating an org (card checkout), deleting one (Stripe), transferring ownership, seat caps,
 * the pool and billing ([D-OW-26]).
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { ORG_POLICY_KEYS } from '@pagespace/sdk';
import { oneOf, verbHandler, type ParsedVerbArgs, type VerbArgsResult } from './verb.js';
import { policyValueLabel } from './orgs.js';

type Orgs = PageSpaceClient['organizations'];
type Out<K extends keyof Orgs> = Awaited<ReturnType<Orgs[K]>>;
type In<K extends keyof Orgs> = Parameters<Orgs[K]>[0];

const GRANTABLE_ROLES = ['ADMIN', 'MEMBER'] as const;
const AUTOMATION_KINDS = ['workflow', 'page_webhook'] as const;
const AUDIT_CATEGORIES = [
  'membership',
  'seats',
  'invites',
  'policies',
  'domains',
  'visibility',
  'drive_moves',
  'private_drive_access',
  'wallets',
  'donations',
  'billing',
  'compute',
  'automations',
] as const;
const MAILBOXES = ['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster'] as const;

const ok = <T>(value: T): VerbArgsResult<T> => ({ ok: true, value });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string | null) => (iso === null ? '-' : iso.slice(0, 10));

// ---------------------------------------------------------------------------
// Policies: `key=value` assignments (pure)
// ---------------------------------------------------------------------------

const BOOLEAN_POLICIES = new Set([
  'requireStrongSignIn',
  'publicShareLinks',
  'publishWeb',
  'customDomains',
  'agentsAutonomous',
  'crossDriveAgents',
  'cloudSandbox',
  'persistentEnvironments',
  'publishedApps',
]);
const LIST_POLICIES = new Set(['modelAllowlist', 'providerAllowlist', 'integrationsAllowlist']);
const SET_POLICIES_USAGE = 'Usage: pagespace orgs set-policies <orgId> <key>=<value> [<key>=<value> ...]';

/**
 * Pure: `key=value` assignments as a policy change. Booleans are on/off/true/false; numbers are
 * whole numbers, `maximumSessionAgeMinutes=none` clears the maximum; an allowlist is a comma
 * list, `none` for no restriction and an empty value for "nothing allowed"; every other policy
 * is its word as-is. Unknown keys are refused before the network; the server judges the values.
 */
export function parsePolicyAssignments(assignments: readonly string[]): VerbArgsResult<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const at = assignment.indexOf('=');
    if (at <= 0) return { ok: false, message: `Expected <key>=<value>, got "${assignment}".\n${SET_POLICIES_USAGE}` };
    const key = assignment.slice(0, at);
    const raw = assignment.slice(at + 1);
    if (!(ORG_POLICY_KEYS as readonly string[]).includes(key)) {
      return { ok: false, message: `Unknown policy "${key}". Policies: ${ORG_POLICY_KEYS.join(', ')}.` };
    }
    if (key in patch) return { ok: false, message: `Policy "${key}" was given twice.` };
    if (BOOLEAN_POLICIES.has(key)) {
      const on = ['on', 'true'].includes(raw) ? true : ['off', 'false'].includes(raw) ? false : null;
      if (on === null) return { ok: false, message: `${key} must be on or off.` };
      patch[key] = on;
    } else if (LIST_POLICIES.has(key)) {
      patch[key] = raw === 'none' ? null : raw === '' ? [] : raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
    } else if (key === 'maximumSessionAgeMinutes') {
      if (raw === 'none') {
        patch[key] = null;
      } else if (/^\d+$/.test(raw)) {
        patch[key] = Number(raw);
      } else {
        return { ok: false, message: `${key} must be a whole number of minutes, or none.` };
      }
    } else {
      patch[key] = raw;
    }
  }
  return ok(patch);
}

/**
 * The value of each policy that only ever OPENS access (or adds no requirement). Any other value may
 * tighten something — suspend share links, published pages, guests or integrations, or demand a new
 * sign-in — relative to whatever the org has now, which the CLI does not read before asking.
 */
const OPENING_VALUES: Readonly<Record<string, unknown>> = {
  requireStrongSignIn: false,
  maximumSessionAgeMinutes: null,
  guests: 'on',
  whoCanInvite: 'members',
  whoCanCreateDrives: 'members',
  openDriveRoleFloor: 'edit',
  modelAllowlist: null,
  providerAllowlist: null,
  integrationsAllowlist: null,
};

/** Pure: whether a policy change may restrict anything (so `set-policies` asks for `--yes`). Switches open when on. */
export function policyChangeMayRestrict(patch: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(patch).some(([key, value]) =>
    BOOLEAN_POLICIES.has(key) && key !== 'requireStrongSignIn' ? value !== true : value !== OPENING_VALUES[key],
  );
}

// ---------------------------------------------------------------------------
// Renderers (pure)
// ---------------------------------------------------------------------------

/** Pure. */
export function renderInvitations(value: Out<'listInvitations'>): string {
  if (value.invitations.length === 0) return 'No open invitations.\n';
  return [
    `${plural(value.invitations.length, 'open invitation', 'open invitations')}:`,
    ...value.invitations.map((i) => `  ${i.id}  [${i.role}]  ${i.email}  expires ${day(i.expiresAt)}`),
    '',
  ].join('\n');
}

/** Pure. */
export function renderPolicyChange(value: Out<'updatePolicies'>): string {
  const counts = (label: string, record: Record<string, number>) => {
    const entries = Object.entries(record).filter(([, n]) => n > 0);
    return entries.length === 0 ? [] : [`  ${label}: ${entries.map(([kind, n]) => `${kind} ${n}`).join(', ')}`];
  };
  return [
    value.changed.length === 0 ? 'No policy changed.' : `Changed: ${value.changed.map((key) => `${key}=${policyValueLabel((value.policies as Record<string, string | number | boolean | readonly string[] | null>)[key] ?? null)}`).join(', ')}`,
    ...counts('suspended', value.suspended),
    ...counts('restored', value.restored),
    ...counts('blocked where used', value.blocked),
    ...(value.auditRecorded ? [] : ['  warning: the change applied but its audit entry was not recorded']),
    '',
  ].join('\n');
}

/** Pure. */
export function renderAuditLog(value: Out<'getAuditLog'>): string {
  if (value.entries.length === 0) return 'No audit entries.\n';
  return [
    ...value.entries.map(
      (e) => `${e.timestamp}  ${e.eventType}  by ${e.actorName ?? e.actorId ?? '(system)'}${e.resourceType ? `  ${e.resourceType}:${e.resourceId ?? ''}` : ''}${e.driveId ? `  drive ${e.driveId}` : ''}`,
    ),
    ...(value.nextCursor === null ? [] : [`More: --before ${value.nextCursor}`]),
    '',
  ].join('\n');
}

/** Pure. */
export function renderSuspended(value: Out<'listSuspended'>): string {
  const listings = value.suspended.filter((l) => l.total > 0);
  if (listings.length === 0) return 'Nothing is suspended by policy.\n';
  return [
    ...listings.flatMap((l) => [`${l.kind} (${l.resourceType}): ${l.total}`, ...l.items.map((item) => `  ${item.id}  ${item.label}${item.driveName ? `  in ${item.driveName}` : ''}`)]),
    '',
  ].join('\n');
}

/** Pure. */
export function renderMemberActivity(value: Out<'listMemberActivity'>): string {
  if (value.activity.length === 0) return 'No members.\n';
  return [...value.activity.map((a) => `  ${a.userId}  ${plural(a.driveCount, 'drive', 'drives')}  last active ${day(a.lastActiveAt)}`), ''].join('\n');
}

/** Pure. */
export function renderTrashedDrives(value: Out<'listTrashedDrives'>): string {
  if (value.drives.length === 0) return 'No trashed drives.\n';
  return [...value.drives.map((d) => `  ${d.id}  ${d.name}  trashed ${day(d.trashedAt)}  lead: ${d.lead.name ?? d.lead.id}`), ''].join('\n');
}

/** Pure. */
export function renderDriveUsage(value: Out<'getDriveUsage'>): string {
  if (value.usage.length === 0) return 'No organization drives.\n';
  return [...value.usage.map((u) => `  ${u.driveId}  ${plural(u.memberCount, 'person', 'people')} (${u.guestCount} guests)  ${u.storageBytes} bytes`), ''].join('\n');
}

/** Pure. */
export function renderAutomations(value: Out<'listAutomations'>): string {
  if (value.automations.length === 0) return 'No automations are waiting for a new owner.\n';
  return [...value.automations.map((a) => `  ${a.kind}  ${a.id}  ${a.name}  drive ${a.driveId}  owner left ${day(a.ownerLeftAt)}`), ''].join('\n');
}

/** Pure. */
export function renderGuests(value: Out<'listGuests'>): string {
  if (value.guests.length === 0) return 'No guests.\n';
  return [
    ...value.guests.map((g) => `  ${g.userId}  ${g.name ?? g.email ?? '(unknown)'}  drives: ${g.drives.map((d) => `${d.name}${d.pending ? ' (pending)' : ''}`).join(', ')}`),
    '',
  ].join('\n');
}

/** Pure. */
export function renderGuestApprovals(value: Out<'listGuestApprovals'>): string {
  if (value.total === 0) return 'No guests are waiting for approval.\n';
  return [
    `${plural(value.total, 'request', 'requests')} waiting:`,
    ...value.items.map((h) => `  ${h.holdId}  ${h.requesterName ?? h.email ?? h.userId ?? '(unknown)'}  → ${h.driveName}  as ${h.request.role ?? 'member'}  (${h.origin})`),
    '',
  ].join('\n');
}

/** Pure. */
export function renderDomains(value: Out<'listDomains'>): string {
  if (value.domains.length === 0) return 'No domains.\n';
  return [
    ...value.domains.flatMap((d) => [
      `  ${d.id}  ${d.domain}  ${d.verifiedAt ? `verified (${d.verifiedMethod ?? 'unknown'}) ${day(d.verifiedAt)}` : 'pending'}`,
      ...(d.verifiedAt === null && d.dnsRecord ? [`      TXT ${d.dnsRecord.name}  "${d.dnsRecord.value}"`] : []),
    ]),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

const orgOnly = (usage: string) => ({ usage, positionals: 1, build: (p: ParsedVerbArgs) => ok({ orgId: p.positionals[0] }) });

export const orgsUpdateHandler = verbHandler({
  usage: 'Usage: pagespace orgs update <orgId> [--name <name>] [--slug <slug>] [--avatar-url <https url>|none]',
  positionals: 1,
  flags: ['name', 'slug', 'avatar-url'],
  build: ({ positionals, options }): VerbArgsResult<In<'update'>> => {
    if (options.name === undefined && options.slug === undefined && options['avatar-url'] === undefined) {
      return { ok: false, message: 'Nothing to update: give --name, --slug or --avatar-url.' };
    }
    return ok({
      orgId: positionals[0],
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.slug !== undefined ? { slug: options.slug } : {}),
      ...(options['avatar-url'] !== undefined ? { avatarUrl: options['avatar-url'] === 'none' ? null : options['avatar-url'] } : {}),
    });
  },
  call: (sdk, input) => sdk.organizations.update(input),
  render: ({ organization: o }) => `Updated ${o.name} (${o.slug})  ${o.id}\n`,
});

export const orgsActivityHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs activity <orgId>'),
  call: (sdk, input) => sdk.organizations.listMemberActivity(input),
  render: renderMemberActivity,
});

export const orgsSetRoleHandler = verbHandler({
  usage: 'Usage: pagespace orgs set-role <orgId> <userId> <ADMIN|MEMBER> [--yes]',
  positionals: 3,
  build: ({ positionals: [orgId, userId, role] }): VerbArgsResult<In<'changeMemberRole'>> => {
    const parsed = oneOf(role, GRANTABLE_ROLES, 'Role', 'Usage: pagespace orgs set-role <orgId> <userId> <ADMIN|MEMBER> [--yes]');
    return parsed.ok ? ok({ orgId, userId, role: parsed.value }) : parsed;
  },
  // MEMBER can be a demotion: an Admin loses org-wide power over every drive.
  confirm: ({ orgId, userId, role }) => (role === 'MEMBER' ? `Set ${userId} to MEMBER in organization ${orgId}? An Admin loses access to every drive they reached through the org. [y/N] ` : null),
  call: (sdk, input) => sdk.organizations.changeMemberRole(input),
  render: (value) => `${value.userId} is now ${value.role}.\n`,
});

export const orgsRemoveMemberHandler = verbHandler({
  usage: 'Usage: pagespace orgs remove-member <orgId> <userId> [--yes]',
  positionals: 2,
  build: ({ positionals: [orgId, userId] }) => ok({ orgId, userId }),
  confirm: ({ orgId, userId }) => `Remove ${userId} from organization ${orgId}? They lose the org drives they reached through it. [y/N] `,
  call: (sdk, input) => sdk.organizations.removeMember(input),
  render: (_value, input) => `Removed ${input.userId} from ${input.orgId}.\n`,
});

export const orgsLeaveHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs leave <orgId> [--yes]'),
  confirm: ({ orgId }) => `Leave organization ${orgId}? You lose the org drives you reached through it. [y/N] `,
  call: (sdk, input) => sdk.organizations.leave(input),
  render: (_value, input) => `You left ${input.orgId}.\n`,
});

export const orgsInvitationsHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs invitations <orgId>'),
  call: (sdk, input) => sdk.organizations.listInvitations(input),
  render: renderInvitations,
});

export const orgsInviteHandler = verbHandler({
  usage: 'Usage: pagespace orgs invite <orgId> <email> [--role ADMIN|MEMBER]',
  positionals: 2,
  flags: ['role'],
  build: ({ positionals: [orgId, email], options }): VerbArgsResult<In<'invite'>> => {
    if (options.role === undefined) return ok({ orgId, email });
    const role = oneOf(options.role, GRANTABLE_ROLES, 'Role', 'Usage: pagespace orgs invite <orgId> <email> [--role ADMIN|MEMBER]');
    return role.ok ? ok({ orgId, email, role: role.value }) : role;
  },
  call: (sdk, input) => sdk.organizations.invite(input),
  render: ({ invitation: i }) => `Invited ${i.email} as ${i.role} (invitation ${i.id}, expires ${day(i.expiresAt)}).\n`,
});

export const orgsResendInviteHandler = verbHandler({
  usage: 'Usage: pagespace orgs resend-invite <orgId> <invitationId>',
  positionals: 2,
  build: ({ positionals: [orgId, invitationId] }) => ok({ orgId, invitationId }),
  call: (sdk, input) => sdk.organizations.resendInvitation(input),
  render: ({ invitation: i }) => `Sent ${i.email} a new link (expires ${day(i.expiresAt)}).\n`,
});

export const orgsRevokeInviteHandler = verbHandler({
  usage: 'Usage: pagespace orgs revoke-invite <orgId> <invitationId> [--yes]',
  positionals: 2,
  build: ({ positionals: [orgId, invitationId] }) => ok({ orgId, invitationId }),
  confirm: ({ invitationId }) => `Revoke invitation ${invitationId}? Its link stops working. [y/N] `,
  call: (sdk, input) => sdk.organizations.revokeInvitation(input),
  render: (_value, input) => `Revoked invitation ${input.invitationId}.\n`,
});

export const orgsAcceptInviteHandler = verbHandler({
  usage: 'Usage: pagespace orgs accept-invite <token>',
  positionals: 1,
  build: ({ positionals: [token] }) => ok({ token }),
  call: (sdk, input) => sdk.organizations.acceptInvitation(input),
  render: (value) => (value.joined ? `Joined organization ${value.orgId} as ${value.role}.\n` : `You are already in ${value.orgId} (${value.role}).\n`),
});

export const orgsSetPoliciesHandler = verbHandler({
  usage: SET_POLICIES_USAGE,
  positionals: 2,
  variadic: true,
  build: ({ positionals: [orgId, ...assignments] }): VerbArgsResult<In<'updatePolicies'>> => {
    const patch = parsePolicyAssignments(assignments);
    return patch.ok ? ok({ orgId, ...patch.value } as In<'updatePolicies'>) : patch;
  },
  confirm: ({ orgId, ...patch }) =>
    policyChangeMayRestrict(patch)
      ? `Change the policies of organization ${orgId}? Tightening a policy suspends what it now forbids (share links, published pages, guests, integrations) org-wide, or asks members to sign in again. [y/N] `
      : null,
  call: (sdk, input) => sdk.organizations.updatePolicies(input),
  render: renderPolicyChange,
});

export const orgsSuspendedHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs suspended <orgId>'),
  call: (sdk, input) => sdk.organizations.listSuspended(input),
  render: renderSuspended,
});

export const orgsTrashedDrivesHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs trashed-drives <orgId>'),
  call: (sdk, input) => sdk.organizations.listTrashedDrives(input),
  render: renderTrashedDrives,
});

export const orgsDriveUsageHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs drive-usage <orgId>'),
  call: (sdk, input) => sdk.organizations.getDriveUsage(input),
  render: renderDriveUsage,
});

const AUDIT_USAGE =
  'Usage: pagespace orgs audit <orgId> [--type <eventType>] [--category <category>] [--drive <driveId>] [--from <iso>] [--to <iso>] [--limit <n>] [--before <cursor>]';
const EXPORT_USAGE = 'Usage: pagespace orgs audit-export <orgId> [--type <eventType>] [--category <category>] [--drive <driveId>] [--from <iso>] [--to <iso>]';

/** Pure: the audit filters shared by the log and the export. */
export function buildAuditFilter(options: Readonly<Record<string, string>>, usage: string): VerbArgsResult<Omit<In<'exportAuditLog'>, 'orgId'>> {
  let category: (typeof AUDIT_CATEGORIES)[number] | undefined;
  if (options.category !== undefined) {
    const parsed = oneOf(options.category, AUDIT_CATEGORIES, 'Category', usage);
    if (!parsed.ok) return parsed;
    category = parsed.value;
  }
  return ok({
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(options.drive !== undefined ? { driveId: options.drive } : {}),
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
  });
}

export const orgsAuditHandler = verbHandler({
  usage: AUDIT_USAGE,
  positionals: 1,
  flags: ['type', 'category', 'drive', 'from', 'to', 'limit', 'before'],
  build: ({ positionals: [orgId], options }): VerbArgsResult<In<'getAuditLog'>> => {
    const filter = buildAuditFilter(options, AUDIT_USAGE);
    if (!filter.ok) return filter;
    for (const key of ['limit', 'before'] as const) {
      if (options[key] !== undefined && !/^\d+$/.test(options[key])) return { ok: false, message: `--${key} must be a whole number.\n${AUDIT_USAGE}` };
    }
    return ok({
      orgId,
      ...filter.value,
      ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}),
      ...(options.before !== undefined ? { before: Number(options.before) } : {}),
    });
  },
  call: (sdk, input) => sdk.organizations.getAuditLog(input),
  render: renderAuditLog,
});

export const orgsAuditExportHandler = verbHandler({
  usage: EXPORT_USAGE,
  positionals: 1,
  flags: ['type', 'category', 'drive', 'from', 'to'],
  build: ({ positionals: [orgId], options }): VerbArgsResult<In<'exportAuditLog'>> => {
    const filter = buildAuditFilter(options, EXPORT_USAGE);
    return filter.ok ? ok({ orgId, ...filter.value }) : filter;
  },
  call: (sdk, input) => sdk.organizations.exportAuditLog(input),
  // The CSV as-is: redirect it to a file (`> audit.csv`).
  render: (csv) => csv,
});

export const orgsAutomationsHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs automations <orgId>'),
  call: (sdk, input) => sdk.organizations.listAutomations(input),
  render: renderAutomations,
});

const automationTarget = (usage: string, [orgId, kind, automationId]: readonly string[]) => {
  const parsedKind = oneOf(kind, AUTOMATION_KINDS, 'Kind', usage);
  return parsedKind.ok ? ok({ orgId, kind: parsedKind.value, automationId }) : parsedKind;
};

export const orgsDeleteAutomationHandler = verbHandler({
  usage: 'Usage: pagespace orgs delete-automation <orgId> <workflow|page_webhook> <automationId> [--yes]',
  positionals: 3,
  build: ({ positionals }) => automationTarget('Usage: pagespace orgs delete-automation <orgId> <workflow|page_webhook> <automationId> [--yes]', positionals),
  confirm: ({ kind, automationId }) => `Delete ${kind} ${automationId}? [y/N] `,
  call: (sdk, input) => sdk.organizations.deleteAutomation(input),
  render: (_value, input) => `Deleted ${input.kind} ${input.automationId}.\n`,
});

export const orgsReassignAutomationHandler = verbHandler({
  usage: 'Usage: pagespace orgs reassign-automation <orgId> <workflow|page_webhook> <automationId> <newOwnerId>',
  positionals: 4,
  build: ({ positionals }): VerbArgsResult<In<'reassignAutomation'>> => {
    const target = automationTarget('Usage: pagespace orgs reassign-automation <orgId> <workflow|page_webhook> <automationId> <newOwnerId>', positionals);
    return target.ok ? ok({ ...target.value, newOwnerId: positionals[3] }) : target;
  },
  call: (sdk, input) => sdk.organizations.reassignAutomation(input),
  render: (value, input) => `${input.kind} ${input.automationId} now runs as ${value.newOwnerId}.\n`,
});

export const orgsGuestsHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs guests <orgId>'),
  call: (sdk, input) => sdk.organizations.listGuests(input),
  render: renderGuests,
});

export const orgsGuestApprovalsHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs guest-approvals <orgId>'),
  call: (sdk, input) => sdk.organizations.listGuestApprovals(input),
  render: renderGuestApprovals,
});

export const orgsAnswerGuestHandler = verbHandler({
  usage: 'Usage: pagespace orgs answer-guest <orgId> <holdId> <approve|decline> [--yes]',
  positionals: 3,
  build: ({ positionals: [orgId, holdId, decision] }): VerbArgsResult<In<'answerGuestApproval'>> => {
    const parsed = oneOf(decision, ['approve', 'decline'] as const, 'Decision', 'Usage: pagespace orgs answer-guest <orgId> <holdId> <approve|decline> [--yes]');
    return parsed.ok ? ok({ orgId, holdId, decision: parsed.value }) : parsed;
  },
  confirm: ({ holdId, decision }) => (decision === 'decline' ? `Decline guest request ${holdId}? The guest does not get in. [y/N] ` : null),
  call: (sdk, input) => sdk.organizations.answerGuestApproval(input),
  render: (value, input) => `Guest request ${input.holdId} ${value.decided}.\n`,
});

export const orgsDomainsHandler = verbHandler({
  ...orgOnly('Usage: pagespace orgs domains <orgId>'),
  call: (sdk, input) => sdk.organizations.listDomains(input),
  render: renderDomains,
});

export const orgsAddDomainHandler = verbHandler({
  usage: 'Usage: pagespace orgs add-domain <orgId> <domain>',
  positionals: 2,
  build: ({ positionals: [orgId, domain] }) => ok({ orgId, domain }),
  call: (sdk, input) => sdk.organizations.addDomain(input),
  render: ({ domain: d }) =>
    `Added ${d.domain} (${d.id}), pending.${d.dnsRecord ? ` Publish TXT ${d.dnsRecord.name} "${d.dnsRecord.value}", then run: pagespace orgs verify-domain ${d.orgId} ${d.id} dns` : ''}\n`,
});

export const orgsRemoveDomainHandler = verbHandler({
  usage: 'Usage: pagespace orgs remove-domain <orgId> <domainId> [--yes]',
  positionals: 2,
  build: ({ positionals: [orgId, domainId] }) => ok({ orgId, domainId }),
  confirm: ({ domainId }) => `Remove domain claim ${domainId}? [y/N] `,
  call: (sdk, input) => sdk.organizations.removeDomain(input),
  render: (_value, input) => `Removed domain claim ${input.domainId}.\n`,
});

const VERIFY_USAGE = 'Usage: pagespace orgs verify-domain <orgId> <domainId> dns | email <admin|administrator|hostmaster|postmaster|webmaster>';

/** Pure: `dns`, or `email <mailbox>`. */
export function buildVerifyDomain(positionals: readonly string[]): VerbArgsResult<In<'verifyDomain'>> {
  const [orgId, domainId, method, mailbox] = positionals;
  if (method === 'dns' && positionals.length === 3) return ok({ orgId, domainId, method: 'dns' });
  if (method === 'email' && positionals.length === 4) {
    const parsed = oneOf(mailbox, MAILBOXES, 'Mailbox', VERIFY_USAGE);
    return parsed.ok ? ok({ orgId, domainId, method: 'email', mailbox: parsed.value }) : parsed;
  }
  return { ok: false, message: VERIFY_USAGE };
}

export const orgsVerifyDomainHandler = verbHandler({
  usage: VERIFY_USAGE,
  positionals: 3,
  variadic: true,
  build: ({ positionals }) => buildVerifyDomain(positionals),
  call: (sdk, input) => sdk.organizations.verifyDomain(input),
  render: (value) =>
    'sentTo' in value
      ? `Sent a verification link to ${value.sentTo} (expires ${day(value.expiresAt)}); confirm it with: pagespace orgs confirm-domain <token>\n`
      : `${value.domain.domain} is ${value.alreadyVerified ? 'already ' : ''}verified.\n`,
});

export const orgsConfirmDomainHandler = verbHandler({
  usage: 'Usage: pagespace orgs confirm-domain <token>',
  positionals: 1,
  build: ({ positionals: [token] }) => ok({ token }),
  call: (sdk, input) => sdk.organizations.confirmDomainEmail(input),
  render: (value) => `${value.domain} is verified.\n`,
});

export const orgsClearSuppressionHandler = verbHandler({
  usage: 'Usage: pagespace orgs clear-suppression <orgId> <email>',
  positionals: 2,
  build: ({ positionals: [orgId, email] }) => ok({ orgId, email }),
  call: (sdk, input) => sdk.organizations.clearSuppression(input),
  render: (value) => (value.cleared ? 'Cleared: that address may be auto-joined again.\n' : 'Nothing to clear for that address.\n'),
});
