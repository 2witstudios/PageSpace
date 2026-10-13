'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';
import { membersVariantFor } from './members-variant';
import { renderInvitePaneBody, renderMembersPaneBody, renderProfilePaneBody } from './members-pane.render';
import { memberGroups } from './members-roster';
import { useMembersDirectory } from './use-members-directory';
import { useMembersRoster } from './use-members-roster';

/**
 * The Members tool's pane. The overview (C-Members) lists the group rows with live counts; a
 * member's profile (C-Members-Profile) lists the people, agents and guests with the current one
 * marked; the invite form (C-Members-Invite) lists who is waiting to join and the invite links.
 */
export function MembersPane({ driveId, close }: ToolPaneProps): ReactNode {
  const variant = membersVariantFor(usePathname());
  const overview = variant.kind === 'overview';
  const roster = useMembersRoster(driveId, overview);
  const directory = useMembersDirectory(driveId, !overview);

  if (variant.kind === 'overview') {
    return renderToolPane({
      title: 'Members',
      label: 'Member groups',
      close,
      children: renderMembersPaneBody({
        driveId,
        groups: roster.roster === undefined && roster.error === undefined ? undefined : memberGroups(roster.roster),
        error: roster.error !== undefined,
        retry: roster.retry,
      }),
    });
  }

  const body =
    variant.kind === 'profile'
      ? renderProfilePaneBody({ driveId, currentUserId: variant.userId, directory: directory.directory, error: directory.error !== undefined, retry: directory.retry })
      : renderInvitePaneBody({ driveId, directory: directory.directory, error: directory.error !== undefined, retry: directory.retry });
  return renderToolPane({
    title: 'Members',
    label: variant.kind === 'profile' ? 'Members' : 'Member groups',
    close,
    children: body,
  });
}
