'use client';

import { useDriveStore } from '@/retained/hooks/useDrive';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import { useParams, useRouter } from '@/retained-adapters/navigation';
import { Button } from '@/retained/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/retained/components/ui/avatar';
import { Badge } from '@/retained/components/ui/badge';
import { PermissionsGrid, PermissionsGridRef } from '@/retained/components/members/PermissionsGrid';
import { UserSearch } from '@/retained/components/members/UserSearch';
import { User, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Label } from '@/retained/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/retained/components/ui/radio-group';
import { post, fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { getRoleColorClasses } from '@/retained/lib/utils';
import { VerificationRequiredAlert } from '@/retained/components/VerificationRequiredAlert';
import { membersDirectoryKey } from '@/ui/tools/members/use-members-directory';
import { membersRosterKey } from '@/ui/tools/members/use-members-roster';

import { inviteeStanding } from '@pagespace/lib/organizations/invite-choice';
import { InviteJoinChoice, defaultJoinChoice, useInviteOrgContext, type JoinChoice } from '@/retained/components/members/InviteJoinChoice';
import { useMyOrganizations } from '@/retained/hooks/useMyOrganizations';
import { LAPSED_LOOSEN_NOTE } from '@/retained/hooks/useOrgLapsed';
import { orgErrorCode, orgErrorMessage, orgErrorPolicy } from '@/retained/lib/orgs/org-error-copy';

interface SelectedUser {
  userId: string;
  username?: string;
  displayName: string;
  // Optional: substring profile matches no longer carry an email (M3); invites
  // use userId, so the email is display-only here.
  email?: string;
  avatarUrl?: string;
}

interface CustomRole {
  id: string;
  name: string;
  description?: string;
  color?: string;
  isDefault: boolean;
  permissions: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
}

// Unified role type: Admin or a custom role
type UnifiedRole = { type: 'admin' } | { type: 'custom'; roleId: string } | null;

/** The invite expiry choices (C-Members-Invite: Never / 1 / 7 / 30 days); Never is null. */
const EXPIRY_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string; readonly days: number | null }> = [
  { value: 'never', label: 'Never', days: null },
  { value: '1', label: '1 day', days: 1 },
  { value: '7', label: '7 days', days: 7 },
  { value: '30', label: '30 days', days: 30 },
];

const roleValue = (role: UnifiedRole): string =>
  role?.type === 'admin' ? 'admin' : role?.type === 'custom' ? role.roleId : 'none';

const getInitials = (name: string) =>
  name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

/** Invite someone to this drive by search or by email, with a role and (for email) an expiry. */
export default function InviteMemberPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const driveName = useDriveStore((state) => state.drives.find((drive) => drive.id === driveId)?.name);
  const { mutate } = useSWRConfig();

  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [selectedUnifiedRole, setSelectedUnifiedRole] = useState<UnifiedRole>(null);
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [showVerificationAlert, setShowVerificationAlert] = useState(false);
  const permissionsGridRef = useRef<PermissionsGridRef>(null);

  // UI-5: on an org drive, an outsider joins as a guest of this drive or as a member of the org.
  const drive = useDriveStore((state) => state.drives.find((d) => d.id === driveId));
  const driveOrgId = drive?.orgId ?? null;
  const { orgById } = useMyOrganizations();
  const orgName = orgById(driveOrgId)?.name ?? 'the organization';
  // [D-OW-33] a lapsed org invites nobody, to the drive or to the org, until it pays.
  const lapsed = orgById(driveOrgId)?.lapsed === true;
  const orgContext = useInviteOrgContext(driveOrgId);
  const [joinChoice, setJoinChoice] = useState<JoinChoice | null>(null);
  // POL-2: an inviter who cannot read the policy learns it from a refusal naming `guests`.
  const [guestsRefused, setGuestsRefused] = useState(false);
  const guestPolicy = guestsRefused ? 'off' : orgContext.guestPolicy;
  const invitee = selectedUser ? { userId: selectedUser.userId, email: selectedUser.email ?? null } : pendingEmail ? { email: pendingEmail } : null;
  const isOutsider = orgContext.enabled && invitee !== null && inviteeStanding(invitee, orgContext.members) === 'outsider';
  const effectiveJoinChoice: JoinChoice | null = isOutsider
    ? joinChoice ?? defaultJoinChoice({ driveName: drive?.name ?? 'this drive', orgName, guestPolicy, hasEmail: Boolean(invitee?.email) })
    : null;

  // Fetch custom roles
  useEffect(() => {
    const fetchRoles = async () => {
      try {
        const response = await fetchWithAuth(`/api/drives/${driveId}/roles`);
        if (response.ok) {
          const data = await response.json();
          setCustomRoles(data.roles || []);
          // Auto-select default role if exists
          const defaultRole = data.roles?.find((r: CustomRole) => r.isDefault);
          if (defaultRole) {
            setSelectedUnifiedRole({ type: 'custom', roleId: defaultRole.id });
          }
        }
      } catch (error) {
        console.error('Error fetching roles:', error);
      }
    };
    fetchRoles();
  }, [driveId]);

  const handleUnifiedRoleChange = (value: string) => {
    if (value === 'admin') {
      setSelectedUnifiedRole({ type: 'admin' });
      setPermissions(new Map()); // Admin has full access; no page rows apply
    } else if (value === 'none') {
      setSelectedUnifiedRole(null);
    } else {
      setSelectedUnifiedRole({ type: 'custom', roleId: value });
      // Prefill the page grid from the role's permissions
      const role = customRoles.find((r) => r.id === value);
      if (role && permissionsGridRef.current) {
        permissionsGridRef.current.applyRolePermissions(role.permissions);
      }
    }
  };

  const handleUserSelect = (user: SelectedUser) => {
    setJoinChoice(null);
    setSelectedUser(user);
    setPendingEmail(null);
  };

  const handleInviteEmail = (email: string) => {
    setJoinChoice(null);
    setPendingEmail(email);
    setSelectedUser(null);
  };

  const handleChangeWho = () => {
    setJoinChoice(null);
    setSelectedUser(null);
    setPendingEmail(null);
    setPermissions(new Map());
    setSelectedUnifiedRole(null);
    setExpiryDays(null);
  };

  const handlePermissionChange = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
    setPermissions((prevPermissions) => {
      const newPermissions = new Map(prevPermissions);
      newPermissions.set(pageId, perms);
      return newPermissions;
    });
  };

  const handleInvite = async () => {
    if ((!selectedUser && !pendingEmail) || lapsed) return;

    // UI-5: an outsider joining as a member of the org gets an org invitation, which holds a seat.
    if (effectiveJoinChoice === 'member' && driveOrgId && invitee?.email) {
      setSaving(true);
      try {
        await post(`/api/orgs/${driveOrgId}/invitations`, { email: invitee.email, role: 'MEMBER' });
        toast.success(`Invitation to ${orgName} sent to ${invitee.email}. Once they accept they can open every Open drive.`);
        router.push(`/dashboard/${driveId}/members`);
      } catch (error) {
        toast.error(orgErrorMessage(error, 'The invitation could not be sent.'));
      } finally {
        setSaving(false);
      }
      return;
    }

    const backendRole = selectedUnifiedRole?.type === 'admin' ? 'ADMIN' : 'MEMBER';
    const backendCustomRoleId = selectedUnifiedRole?.type === 'custom' ? selectedUnifiedRole.roleId : null;
    const isAdmin = selectedUnifiedRole?.type === 'admin';

    // Snapshot the email at submit time so the toast renders the right address
    // even if pendingEmail changes before the async response resolves.
    const submittedEmail = pendingEmail;

    let payload: Record<string, unknown>;
    if (pendingEmail) {
      // Email-payload path: page permissions cannot be granted to a user who
      // has not joined yet, so we always send an empty permissions array.
      payload = {
        email: pendingEmail,
        role: backendRole,
        customRoleId: backendCustomRoleId,
        permissions: [],
        ...(expiryDays !== null && { expiryDays }),
      };
    } else if (isAdmin) {
      payload = {
        userId: selectedUser!.userId,
        role: 'ADMIN',
        customRoleId: null,
        permissions: [],
      };
    } else {
      const permissionArray = Array.from(permissions.entries())
        .filter(([, perms]) => perms.canView || perms.canEdit || perms.canShare)
        .map(([pageId, perms]) => ({
          pageId,
          canView: perms.canView,
          canEdit: perms.canEdit,
          canShare: perms.canShare,
        }));

      if (permissionArray.length === 0 && !backendCustomRoleId) {
        toast.error('Please assign a role or select at least one page permission');
        return;
      }

      payload = {
        userId: selectedUser!.userId,
        role: backendRole,
        customRoleId: backendCustomRoleId,
        permissions: permissionArray,
      };
    }

    setSaving(true);
    try {
      const response = await post<{ kind?: 'invited' | 'added' | 'pending_approval'; email?: string }>(
        `/api/drives/${driveId}/members/invite`,
        payload,
      );

      if (response?.kind === 'pending_approval') {
        toast.success(`Sent to the ${orgName} Owner and Admins for approval. Nothing is shared until they approve.`);
      } else if (response?.kind === 'invited' && submittedEmail) {
        toast.success(`Invitation sent to ${submittedEmail}`);
      } else {
        toast.success(isAdmin ? 'Admin invited successfully' : 'Member invited successfully');
      }

      // The Members pane lists the waiting invite and the counts: ask them again.
      void mutate(membersDirectoryKey(driveId));
      void mutate(membersRosterKey(driveId));
      router.push(`/dashboard/${driveId}/members`);
    } catch (error) {
      if (error instanceof Error && 'requiresEmailVerification' in error) {
        setShowVerificationAlert(true);
        return;
      }
      console.error('Error adding member:', error);
      if (orgErrorPolicy(error) === 'guests') {
        setGuestsRefused(true);
        setJoinChoice(null);
        toast.error(`Guests are turned off for ${orgName}, so they cannot join as a guest.${invitee?.email ? ' Give them a seat instead.' : ''}`);
        return;
      }
      toast.error(orgErrorCode(error) ? orgErrorMessage(error, 'Failed to add member') : error instanceof Error ? error.message : 'Failed to add member');
    } finally {
      setSaving(false);
    }
  };

  const target = selectedUser ? selectedUser.displayName : pendingEmail;
  const roleName =
    selectedUnifiedRole?.type === 'admin'
      ? 'Admin'
      : selectedUnifiedRole?.type === 'custom'
        ? (customRoles.find((r) => r.id === selectedUnifiedRole.roleId)?.name ?? 'custom role')
        : 'No role';
  const expiryLabel = pendingEmail && expiryDays !== null ? `, expires in ${expiryDays} day${expiryDays === 1 ? '' : 's'}` : '';
  // The page grid is for a joined user with No role (or a role prefilled into it); an email invite cannot carry page rows.
  const showGrid = selectedUser !== null && selectedUnifiedRole?.type !== 'admin';

  return (
    <form
      className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-6"
      onSubmit={(event) => {
        event.preventDefault();
        void handleInvite();
      }}
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">{driveName ? `Invite to ${driveName}` : 'Invite people'}</h1>
        <p className="text-sm text-muted-foreground">Find someone on PageSpace, or type an email and they&rsquo;ll get an invitation.</p>
      </header>

      {lapsed && <p className="text-sm text-muted-foreground" data-testid="lapsed-loosen-note">Inviting is paused while {orgName} is unpaid. {LAPSED_LOOSEN_NOTE}</p>}

      {showVerificationAlert && <VerificationRequiredAlert onDismiss={() => setShowVerificationAlert(false)} />}

      <section aria-labelledby="invite-who" className="flex flex-col gap-3">
        <h2 id="invite-who" className="flex items-center gap-2 text-sm font-semibold">
          <span className="grid size-5 place-items-center rounded-full bg-muted text-xs">1</span>
          Who
        </h2>
        {selectedUser ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-muted p-4">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar className="size-10">
                <AvatarImage src={selectedUser.avatarUrl} alt={selectedUser.displayName} />
                <AvatarFallback>{selectedUser.displayName ? getInitials(selectedUser.displayName) : <User className="size-4" />}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {selectedUser.displayName}
                  {selectedUser.username && <span className="ml-2 text-sm text-muted-foreground">@{selectedUser.username}</span>}
                </p>
                {selectedUser.email && <p className="truncate text-sm text-muted-foreground">{selectedUser.email}</p>}
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={handleChangeWho}>
              Change
            </Button>
          </div>
        ) : pendingEmail ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-muted p-4">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar className="size-10">
                <AvatarFallback>
                  <Mail className="size-4" />
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate font-medium">{pendingEmail}</p>
                <p className="text-sm text-muted-foreground">No PageSpace account yet · they&rsquo;ll get an invitation</p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={handleChangeWho}>
              Change
            </Button>
          </div>
        ) : (
          <UserSearch onSelect={handleUserSelect} onInviteEmail={handleInviteEmail} />
        )}
      </section>

        {isOutsider && invitee && effectiveJoinChoice && (
          <InviteJoinChoice
            inviteeName={selectedUser?.displayName ?? pendingEmail ?? 'They'}
            invitee={invitee}
            driveName={drive?.name ?? 'This drive'}
            orgName={orgName}
            members={orgContext.members}
            guestPolicy={guestPolicy}
            value={effectiveJoinChoice}
            onChange={setJoinChoice}
          />
        )}

      {(selectedUser || pendingEmail) && effectiveJoinChoice !== 'member' && (
        <>
          <section aria-labelledby="invite-role" className="flex flex-col gap-3">
            <h2 id="invite-role" className="flex items-center gap-2 text-sm font-semibold">
              <span className="grid size-5 place-items-center rounded-full bg-muted text-xs">3</span>
              Role
            </h2>
            <RadioGroup value={roleValue(selectedUnifiedRole)} onValueChange={handleUnifiedRoleChange} aria-label="Role">
              <RadioRow id="role-admin" value="admin" label={<Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">Admin</Badge>} hint="Full access" />
              {customRoles.map((role) => (
                <RadioRow
                  key={role.id}
                  id={`role-${role.id}`}
                  value={role.id}
                  label={<Badge className={getRoleColorClasses(role.color)}>{role.name}</Badge>}
                  hint={role.isDefault ? 'Default' : undefined}
                />
              ))}
              <RadioRow id="role-none" value="none" label={<span className="text-sm">No role</span>} />
            </RadioGroup>
            <p className="text-sm text-muted-foreground">
              {selectedUnifiedRole?.type === 'admin'
                ? 'Admins have the same permissions as drive owners and can manage members.'
                : 'This role defines which pages this member can access.'}
            </p>
            {showGrid && (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Page permissions</p>
                <PermissionsGrid
                  ref={permissionsGridRef}
                  driveId={driveId}
                  permissions={permissions}
                  onChange={handlePermissionChange}
                  readOnlyDriveRoot
                />
              </div>
            )}
          </section>

          {pendingEmail && (
            <section aria-labelledby="invite-expiry" className="flex flex-col gap-3">
              <h2 id="invite-expiry" className="flex items-center gap-2 text-sm font-semibold">
                <span className="grid size-5 place-items-center rounded-full bg-muted text-xs">4</span>
                Invite expiry
              </h2>
              <RadioGroup
                value={expiryDays === null ? 'never' : String(expiryDays)}
                onValueChange={(v) => setExpiryDays(EXPIRY_OPTIONS.find((o) => o.value === v)?.days ?? null)}
                aria-label="Invite expiry"
                className="flex flex-row flex-wrap gap-4"
              >
                {EXPIRY_OPTIONS.map((option) => (
                  <RadioRow key={option.value} id={`expiry-${option.value}`} value={option.value} label={<span className="text-sm">{option.label}</span>} />
                ))}
              </RadioGroup>
            </section>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <p className="min-w-0 truncate text-sm text-muted-foreground">
              Invite {target} as {roleName}
              {expiryLabel}
            </p>
            <div className="flex flex-none gap-2">
              <Button type="button" variant="outline" onClick={() => router.push(`/dashboard/${driveId}/members`)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || lapsed}>
                {saving ? 'Sending…' : 'Send invite'}
              </Button>
            </div>
          </div>
        </>
      )}
      {effectiveJoinChoice === 'member' && (
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" onClick={() => router.push(`/dashboard/${driveId}/members`)} disabled={saving}>Cancel</Button>
          <Button type="submit" disabled={saving || lapsed}>{saving ? 'Sending…' : `Invite to ${orgName}`}</Button>
        </div>
      )}
    </form>
  );
}

function RadioRow({ id, value, label, hint }: { readonly id: string; readonly value: string; readonly label: ReactNode; readonly hint?: string }) {
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem id={id} value={value} />
      <Label htmlFor={id} className="flex cursor-pointer items-center gap-2 font-normal">
        {label}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </Label>
    </div>
  );
}
