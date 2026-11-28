'use client';

// What /[driveId]/settings opens in the middle: the drive's identity and its settings as link
// rows, each with the live state apps/web reports for it. It replaces the old double render
// (the retained link list beside the native object). Owner and admin answers are only asked
// for when the viewer may manage the drive, so a plain member makes no request they would be
// refused.

import Link from 'next/link';
import useSWR from 'swr';
import type { ReactNode } from 'react';
import { homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { cn } from '../../cn';
import { edgeOf, renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { DRIVE_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { SettingsGroup, SettingsScreen, SettingsSection } from '../settings-screen/settings-screen';
import { driveEndpoint, driveOf, membersEndpoint, membersFrom, type DriveSettings } from '../settings-model/settings-model';
import {
  backupsHintOf,
  commandsHintOf,
  domainsHintOf,
  integrationsHintOf,
  overviewGroups,
  rolesHintOf,
  type OverviewGroup,
  type OverviewRow,
} from './settings-overview-model';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const drivePath = (driveId: string, rest: string): string => `/api/drives/${encodeURIComponent(driveId)}${rest}`;

const agentsEndpoint = (driveId: string): string => drivePath(driveId, '/agents/members');
const rolesEndpoint = (driveId: string): string => drivePath(driveId, '/roles');
const integrationsEndpoint = (driveId: string): string => drivePath(driveId, '/integrations');
const backupsEndpoint = (driveId: string): string => drivePath(driveId, '/backups/schedule');
const domainsEndpoint = (driveId: string): string => drivePath(driveId, '/domains');
/** apps/web's command list: every command the viewer can use, filtered to this drive below. */
const COMMANDS = '/api/commands';

const rowClass = (danger: boolean): string =>
  cn('flex items-center gap-4 px-4 py-3 text-ink no-underline hover:bg-fill hover:no-underline', danger && 'text-status-danger');

const stateClass = (row: OverviewRow): string =>
  cn('whitespace-nowrap text-xs', row.tone === 'warn' ? 'font-medium text-status-warning' : 'text-ink-muted');

const rowNode = (row: OverviewRow): ReactNode => (
  <Link key={row.id} href={row.href} prefetch={true} className={rowClass(row.danger)} data-settings-row={row.id}>
    <span className="min-w-0 flex-1">
      <span className={cn('block text-sm font-medium', row.danger ? 'text-status-danger' : 'text-ink')}>{row.title}</span>
      <span className="block text-xs text-ink-muted">{row.description}</span>
    </span>
    {row.state === null ? null : <span data-row-state="" className={stateClass(row)}>{row.state}</span>}
  </Link>
);

const groupNode = (group: OverviewGroup): ReactNode => (
  <SettingsSection key={group.label} title={group.label}>
    <SettingsGroup>{group.rows.map(rowNode)}</SettingsGroup>
  </SettingsSection>
);

const isManager = (drive: DriveSettings): boolean => drive.role === 'OWNER' || drive.role === 'ADMIN';

/** The drive's overview. Counts and hints show only once their answer arrives. */
export function DriveSettingsOverview({ driveId }: { readonly driveId: string }): ReactNode {
  const driveQuery = useSWR<unknown>(driveEndpoint(driveId));
  const drive = driveQuery.data === undefined ? undefined : driveOf(driveQuery.data) ?? undefined;
  const raw = isRecord(driveQuery.data) ? driveQuery.data : {};
  const canManage = drive !== undefined && isManager(drive);
  // The Danger zone is the owner's, and a Home drive can never be deleted (its guard refuses).
  const canDelete = drive !== undefined && drive.role === 'OWNER' && homeDriveActionError(drive, 'trash') === null;

  const membersQuery = useSWR<unknown>(drive === undefined ? null : membersEndpoint(driveId));
  const agentsQuery = useSWR<unknown>(drive === undefined ? null : agentsEndpoint(driveId));
  const commandsQuery = useSWR<unknown>(drive === undefined ? null : COMMANDS);
  const rolesQuery = useSWR<unknown>(canManage ? rolesEndpoint(driveId) : null);
  const integrationsQuery = useSWR<unknown>(canManage ? integrationsEndpoint(driveId) : null);
  const backupsQuery = useSWR<unknown>(canManage ? backupsEndpoint(driveId) : null);
  const domainsQuery = useSWR<unknown>(canManage ? domainsEndpoint(driveId) : null);

  if (drive === undefined) {
    if (driveQuery.error === undefined) return renderLoadingState('Loading settings…');
    return edgeOf(driveQuery.error) === 'not-found'
      ? renderNotFound({ ...DRIVE_NOT_FOUND, homeHref: null })
      : renderErrorState({ title: 'Could not load drive settings', retry: () => void driveQuery.mutate() });
  }

  const people = membersQuery.data === undefined ? null : membersFrom(membersQuery.data)?.length ?? null;
  const agentBody = agentsQuery.data;
  const agents = isRecord(agentBody) && Array.isArray(agentBody.agentMembers) ? agentBody.agentMembers.length : null;
  const published = typeof raw.publishSubdomain === 'string' && raw.publishSubdomain !== '' ? `${raw.publishSubdomain}.pagespace.site` : null;
  const prompt = typeof raw.drivePrompt === 'string' ? raw.drivePrompt : null;

  const counts = [
    people === null ? null : `${people} ${people === 1 ? 'person' : 'people'}`,
    agents === null ? null : `${agents} ${agents === 1 ? 'agent' : 'agents'}`,
  ].filter((part): part is string => part !== null);
  const lede = [
    counts.length === 0 ? null : counts.join(' · '),
    published === null ? 'Not published yet' : `Published at ${published}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const groups = overviewGroups({
    driveId,
    canManage,
    isOwner: canDelete,
    hints: {
      commands: commandsQuery.data === undefined ? undefined : commandsHintOf(commandsQuery.data, driveId),
      contextLength: canManage && 'drivePrompt' in raw ? (prompt?.length ?? 0) : undefined,
      roles: rolesQuery.data === undefined ? undefined : rolesHintOf(rolesQuery.data),
      integrations: integrationsQuery.data === undefined ? undefined : integrationsHintOf(integrationsQuery.data),
      backups: backupsQuery.data === undefined ? undefined : backupsHintOf(backupsQuery.data),
      domains: domainsQuery.data === undefined ? undefined : domainsHintOf(domainsQuery.data),
    },
  });

  return (
    <SettingsScreen title={drive.name} lede={lede}>
      {groups.map(groupNode)}
    </SettingsScreen>
  );
}
