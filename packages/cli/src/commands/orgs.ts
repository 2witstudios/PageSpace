/**
 * `pagespace orgs list|get|members|drives|policies` — READ-ONLY organization verbs
 * (Spec X-1). Thin projections over the `organizations.*` SDK operations; argv
 * parsing and rendering are pure, `ctx.sdk` is the only I/O edge.
 *
 * There is deliberately no org write here: every org write (create, rename, invite,
 * remove, role change, policy change, billing) needs a signed-in session in the web
 * app, so there is no write operation in the SDK for these to project. A key reads
 * what the web's `requireOrgRole` gate admits for its owner: org-wide reads refuse a
 * drive-scoped key, and the drive directory shows a scoped key only its own drives.
 *
 * Policies are Owner/Admin facts (SEAT-6): the server refuses a plain member with the
 * same 403 the web answers, and this file renders rather than re-decides.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type OrgsListResult = Awaited<ReturnType<PageSpaceClient['organizations']['list']>>;
type OrgResult = Awaited<ReturnType<PageSpaceClient['organizations']['get']>>;
type OrgMembersResult = Awaited<ReturnType<PageSpaceClient['organizations']['listMembers']>>;
type OrgDrivesResult = Awaited<ReturnType<PageSpaceClient['organizations']['listDrives']>>;
type OrgPoliciesResult = Awaited<ReturnType<PageSpaceClient['organizations']['getPolicies']>>;

const VISIBILITY_LABELS: Readonly<Record<OrgDrivesResult['drives'][number]['orgVisibility'], string>> = {
  OPEN: 'Open',
  RESTRICTED: 'Restricted',
  PRIVATE: 'Private',
};

/** Pure: a policy value as display text; null (no restriction) reads as "(none)". */
export function policyValueLabel(value: string | number | boolean | readonly string[] | null): string {
  if (value === null) return '(none)';
  if (Array.isArray(value)) return value.length === 0 ? '(nothing allowed)' : value.join(', ');
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

/** Pure: no I/O. */
export function renderOrgsList(value: OrgsListResult): string {
  const { organizations } = value;
  if (organizations.length === 0) return 'You belong to no organization.\n';
  return [
    `${organizations.length === 1 ? '1 organization' : `${organizations.length} organizations`}:`,
    ...organizations.map((o) => `  ${o.id}  [${o.role}]  ${o.name} (${o.slug})${o.lapsed ? '  · lapsed: read-only' : ''}`),
    '',
  ].join('\n');
}

/** Pure: no I/O. */
export function renderOrg(value: OrgResult): string {
  const { organization, viewer, billingNotice } = value;
  return [
    `${organization.name} (${organization.slug})  ${organization.id}`,
    `  owner: ${organization.ownerId}  created: ${organization.createdAt.slice(0, 10)}`,
    `  your role: ${viewer.role}`,
    ...(billingNotice && typeof billingNotice === 'object' && 'kind' in billingNotice ? [`  billing notice: ${String(billingNotice.kind)}`] : []),
    '',
  ].join('\n');
}

/** Pure: no I/O. */
export function renderOrgMembers(value: OrgMembersResult): string {
  const { members } = value;
  if (members.length === 0) return 'No members.\n';
  return [
    `${members.length === 1 ? '1 member' : `${members.length} members`}:`,
    ...members.map((m) => `  [${m.role}]  ${m.name} <${m.email}>  ${m.userId}  joined ${m.joinedAt.slice(0, 10)}`),
    '',
  ].join('\n');
}

/** Pure: how a directory line describes the caller's standing in a drive (DRV-6). */
export function directoryStanding(drive: OrgDrivesResult['drives'][number]): string {
  if (drive.joined) return 'joined';
  if (drive.joinRequest === 'pending') return 'join request pending';
  return drive.canRequest ? 'can request to join' : 'not joinable';
}

/** Pure: no I/O. */
export function renderOrgDrives(value: OrgDrivesResult): string {
  const { drives } = value;
  if (drives.length === 0) return 'No drives in this organization\'s directory.\n';
  return [
    `${drives.length === 1 ? '1 drive' : `${drives.length} drives`}:`,
    ...drives.map(
      (d) =>
        `  ${VISIBILITY_LABELS[d.orgVisibility]}  ${d.id}  ${d.name} (${d.slug})  ${directoryStanding(d)}  lead: ${d.lead.name ?? d.lead.id}`,
    ),
    '',
  ].join('\n');
}

/** Pure: no I/O. */
export function renderOrgPolicies(value: OrgPoliciesResult): string {
  const entries = Object.entries(value.policies) as Array<[string, string | number | boolean | readonly string[] | null]>;
  return ['Organization policies:', ...entries.map(([key, val]) => `  ${key}: ${policyValueLabel(val)}`), ''].join('\n');
}

// ---------------------------------------------------------------------------
// argv (pure)
// ---------------------------------------------------------------------------

const LIST_USAGE = 'Usage: pagespace orgs list';
const ORG_USAGE = 'Usage: pagespace orgs get|members|drives|policies <orgId>';

export type ExtractOrgArgsResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** Pure: no arguments at all. */
export function extractOrgsListArgs(args: readonly string[]): ExtractOrgArgsResult<Record<string, never>> {
  if (args.length > 0) return { ok: false, message: LIST_USAGE };
  return { ok: true, value: {} };
}

/** Pure: exactly one `<orgId>`, nothing else. */
export function extractOrgArgs(args: readonly string[]): ExtractOrgArgsResult<{ readonly orgId: string }> {
  if (args.length !== 1 || args[0].startsWith('-') || args[0].length === 0) return { ok: false, message: ORG_USAGE };
  return { ok: true, value: { orgId: args[0] } };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const orgsListHandler: CommandHandler = async (ctx, intent) => {
  const parsed = extractOrgsListArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const result = await callSdk(ctx.stderr, () => ctx.sdk.organizations.list({}));
  if (!result.ok) return EXIT_RUNTIME_ERROR;
  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderOrgsList(result.value));
  return EXIT_SUCCESS;
};

export const orgsGetHandler: CommandHandler = async (ctx, intent) => {
  const parsed = extractOrgArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const result = await callSdk(ctx.stderr, () => ctx.sdk.organizations.get({ orgId: parsed.value.orgId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;
  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderOrg(result.value));
  return EXIT_SUCCESS;
};

export const orgsMembersHandler: CommandHandler = async (ctx, intent) => {
  const parsed = extractOrgArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const result = await callSdk(ctx.stderr, () => ctx.sdk.organizations.listMembers({ orgId: parsed.value.orgId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;
  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderOrgMembers(result.value));
  return EXIT_SUCCESS;
};

export const orgsDrivesHandler: CommandHandler = async (ctx, intent) => {
  const parsed = extractOrgArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const result = await callSdk(ctx.stderr, () => ctx.sdk.organizations.listDrives({ orgId: parsed.value.orgId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;
  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderOrgDrives(result.value));
  return EXIT_SUCCESS;
};

export const orgsPoliciesHandler: CommandHandler = async (ctx, intent) => {
  const parsed = extractOrgArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const result = await callSdk(ctx.stderr, () => ctx.sdk.organizations.getPolicies({ orgId: parsed.value.orgId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;
  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderOrgPolicies(result.value));
  return EXIT_SUCCESS;
};
