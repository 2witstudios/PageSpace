/**
 * `pagespace drives <verb>` for org ownership of a drive (Spec X-1; DRV-1..DRV-4, DRV-6): move a
 * drive into or out of an organization, change its org visibility or lead, and the join-request
 * flow for Restricted drives. Thin projections over the `drives.*` SDK operations, built on
 * `verb.ts`. Moving a drive out (which can remove org members) needs `--yes` or a TTY "y".
 *
 * The services behind the routes authorize through the web's one org authorization function
 * (ORG-5); the key must be unscoped and satisfy the org's sign-in policy.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { IMPLICIT_MEMBERS_CHOICES, JOIN_REQUEST_DECISIONS } from '@pagespace/sdk';
import { oneOf, verbHandler, type VerbArgsResult } from './verb.js';

type Drives = PageSpaceClient['drives'];
type In<K extends keyof Drives> = Parameters<Drives[K]>[0];
type Out<K extends keyof Drives> = Awaited<ReturnType<Drives[K]>>;

const VISIBILITIES = ['OPEN', 'RESTRICTED', 'PRIVATE'] as const;
const ok = <T>(value: T): VerbArgsResult<T> => ({ ok: true, value });

/** Pure. */
export function renderJoinRequests(value: Out<'listJoinRequests'>): string {
  if (value.requests.length === 0) return 'No pending join requests.\n';
  return [
    ...value.requests.map((r) => `  ${r.id}  ${r.name ?? r.email} <${r.email}>  asked ${r.requestedAt.slice(0, 10)}${r.message ? `  "${r.message}"` : ''}`),
    '',
  ].join('\n');
}

const MOVE_IN_USAGE = 'Usage: pagespace drives move-to-org <driveId> <orgId> [--visibility OPEN|RESTRICTED|PRIVATE]';

export const drivesMoveToOrgHandler = verbHandler({
  usage: MOVE_IN_USAGE,
  positionals: 2,
  flags: ['visibility'],
  build: ({ positionals: [driveId, orgId], options }): VerbArgsResult<In<'moveToOrg'>> => {
    if (options.visibility === undefined) return ok({ driveId, orgId });
    const visibility = oneOf(options.visibility, VISIBILITIES, 'Visibility', MOVE_IN_USAGE);
    return visibility.ok ? ok({ driveId, orgId, orgVisibility: visibility.value }) : visibility;
  },
  call: (sdk, input) => sdk.drives.moveToOrg(input),
  render: ({ drive }) => `Moved ${drive.name} (${drive.id}) into organization ${drive.orgId ?? ''} as ${drive.orgVisibility}.\n`,
});

const MOVE_OUT_USAGE = 'Usage: pagespace drives move-out-of-org <driveId> <keep|remove> [--yes]';

export const drivesMoveOutOfOrgHandler = verbHandler({
  usage: MOVE_OUT_USAGE,
  positionals: 2,
  build: ({ positionals: [driveId, choice] }): VerbArgsResult<In<'moveOutOfOrg'>> => {
    const implicitMembers = oneOf(choice, IMPLICIT_MEMBERS_CHOICES, 'Org members', MOVE_OUT_USAGE);
    return implicitMembers.ok ? ok({ driveId, implicitMembers: implicitMembers.value }) : implicitMembers;
  },
  confirm: ({ driveId, implicitMembers }) =>
    `Move drive ${driveId} out of its organization? Org members will ${implicitMembers === 'keep' ? 'keep access as invited members' : 'lose access'}. [y/N] `,
  call: (sdk, input) => sdk.drives.moveOutOfOrg(input),
  render: ({ drive }) => `Moved ${drive.name} (${drive.id}) out of its organization.\n`,
});

const VISIBILITY_USAGE = 'Usage: pagespace drives set-visibility <driveId> <OPEN|RESTRICTED|PRIVATE>';

export const drivesSetVisibilityHandler = verbHandler({
  usage: VISIBILITY_USAGE,
  positionals: 2,
  build: ({ positionals: [driveId, value] }): VerbArgsResult<In<'setOrgVisibility'>> => {
    const visibility = oneOf(value, VISIBILITIES, 'Visibility', VISIBILITY_USAGE);
    return visibility.ok ? ok({ driveId, orgVisibility: visibility.value }) : visibility;
  },
  call: (sdk, input) => sdk.drives.setOrgVisibility(input),
  render: ({ drive }) => `${drive.name} (${drive.id}) is ${drive.orgVisibility}.\n`,
});

export const drivesSetLeadHandler = verbHandler({
  usage: 'Usage: pagespace drives set-lead <driveId> <userId>',
  positionals: 2,
  build: ({ positionals: [driveId, userId] }) => ok({ driveId, userId }),
  call: (sdk, input) => sdk.drives.setOrgLead(input),
  render: ({ drive }) => `${drive.name} (${drive.id}) is now led by ${drive.ownerId}.\n`,
});

export const drivesJoinRequestsHandler = verbHandler({
  usage: 'Usage: pagespace drives join-requests <driveId>',
  positionals: 1,
  build: ({ positionals: [driveId] }) => ok({ driveId }),
  call: (sdk, input) => sdk.drives.listJoinRequests(input),
  render: renderJoinRequests,
});

export const drivesRequestJoinHandler = verbHandler({
  usage: 'Usage: pagespace drives request-join <driveId> [--message <text>]',
  positionals: 1,
  flags: ['message'],
  build: ({ positionals: [driveId], options }) => ok({ driveId, ...(options.message !== undefined ? { message: options.message } : {}) }),
  call: (sdk, input) => sdk.drives.requestToJoin(input),
  render: ({ request }) => `Asked to join drive ${request.driveId} (request ${request.id}, ${request.status}).\n`,
});

const ANSWER_USAGE = 'Usage: pagespace drives answer-join <driveId> <requestId> <approve|deny>';

export const drivesAnswerJoinHandler = verbHandler({
  usage: ANSWER_USAGE,
  positionals: 3,
  build: ({ positionals: [driveId, requestId, value] }): VerbArgsResult<In<'answerJoinRequest'>> => {
    const decision = oneOf(value, JOIN_REQUEST_DECISIONS, 'Decision', ANSWER_USAGE);
    return decision.ok ? ok({ driveId, requestId, decision: decision.value }) : decision;
  },
  call: (sdk, input) => sdk.drives.answerJoinRequest(input),
  render: ({ request, admitted }) => `Request ${request.id} ${request.status}${admitted ? '; the requester is now a member' : ''}.\n`,
});

export const drivesWithdrawJoinHandler = verbHandler({
  usage: 'Usage: pagespace drives withdraw-join <driveId> <requestId>',
  positionals: 2,
  build: ({ positionals: [driveId, requestId] }) => ok({ driveId, requestId }),
  call: (sdk, input) => sdk.drives.withdrawJoinRequest(input),
  render: ({ request }) => `Withdrew request ${request.id}.\n`,
});
