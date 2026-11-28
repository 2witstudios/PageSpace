'use client';

import { useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { Button } from '@/retained/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/retained/components/ui/card';
import { Input } from '@/retained/components/ui/input';
import { Label } from '@/retained/components/ui/label';
import { useOrgAdminRead } from '@/retained/hooks/useOrgs';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { OrgMark } from '@/retained/components/orgs/OrgMark';
import { OrgSettingsShell, type OrgSettingsContext } from '@/retained/components/orgs/OrgSettingsShell';
import { isOrgKey, orgKeys, patchOrganization, removeOrgAvatar, uploadOrgAvatar, type OrgMember } from '@/retained/lib/orgs/org-api';
import { ApiRequestError } from '@/retained/lib/auth/auth-fetch';
import { ORG_AVATAR_MIME_TYPES } from '@pagespace/lib/organizations/org-avatar-core';
import { orgErrorMessage } from '@/retained/lib/orgs/org-error-copy';
import { isValidOrgSlug } from '@/retained/lib/orgs/org-slug';

const EDITING_ID = 'org-general';
const AVATAR_ACCEPT = ORG_AVATAR_MIME_TYPES.filter((type) => type !== 'image/jpg').join(',');

/**
 * ORG-1: the org avatar is an image uploaded to PageSpace (JPEG, PNG, GIF or WebP, up to 5 MB) and
 * served by PageSpace to members; there is no way to point it at a URL.
 */
function AvatarControl({ orgId, hasAvatar, onChanged }: { orgId: string; hasAvatar: boolean; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await work();
      onChanged();
    } catch (error) {
      // The avatar route's refusals are written for people (type, size); anything else gets the fallback.
      toast.error(error instanceof ApiRequestError && error.status === 400 ? error.message : orgErrorMessage(error, failure));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void run(() => uploadOrgAvatar(orgId, file), 'The image could not be uploaded.');
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input ref={input} id="org-general-avatar" type="file" accept={AVATAR_ACCEPT} className="sr-only" aria-label="Upload avatar image" onChange={onFile} disabled={busy} />
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
        {hasAvatar ? 'Change image' : 'Upload image'}
      </Button>
      {hasAvatar ? (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => removeOrgAvatar(orgId), 'The image could not be removed.')}>
          Remove avatar
        </Button>
      ) : null}
      <p className="w-full text-xs text-muted-foreground">JPEG, PNG, GIF or WebP, up to 5 MB.</p>
    </div>
  );
}

function GeneralBody({ orgId, org, role }: OrgSettingsContext) {
  const { mutate } = useSWRConfig();
  const members = useOrgAdminRead<{ members: OrgMember[] }>(orgKeys.members(orgId), role).data?.members;
  const owner = members?.find((m) => m.role === 'OWNER');
  const [name, setName] = useState(org.organization.name);
  const [slug, setSlug] = useState(org.organization.slug);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== org.organization.name || slug.trim() !== org.organization.slug;

  useEffect(() => {
    if (!useEditingStore.getState().isAnyEditing()) {
      setName(org.organization.name);
      setSlug(org.organization.slug);
    }
  }, [org.organization.name, org.organization.slug]);

  useEffect(() => {
    if (dirty) useEditingStore.getState().startEditing(EDITING_ID, 'form', { componentName: 'OrgGeneral' });
    else useEditingStore.getState().endEditing(EDITING_ID);
    return () => useEditingStore.getState().endEditing(EDITING_ID);
  }, [dirty]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return toast.error('Give the organization a name.');
    if (!isValidOrgSlug(slug.trim())) return toast.error('Use 1-48 lowercase letters, digits or hyphens for the URL.');
    setSaving(true);
    try {
      const body: { name?: string; slug?: string } = {};
      if (name.trim() !== org.organization.name) body.name = name.trim();
      if (slug.trim() !== org.organization.slug) body.slug = slug.trim();
      await patchOrganization(orgId, body);
      useEditingStore.getState().endEditing(EDITING_ID);
      toast.success('Saved');
      void mutate((k) => isOrgKey(orgId, k) || k === orgKeys.mine());
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The changes could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Name, avatar and URL</CardTitle>
          <CardDescription>How the organization appears in drive pickers, invitations and the audit log.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="space-y-4">
            <div className="flex items-center gap-3">
              <OrgMark name={name || org.organization.name} avatarUrl={org.organization.avatarUrl} size="lg" decorative />
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="org-general-name">Name</Label>
                <Input id="org-general-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
              </div>
            </div>
            <AvatarControl
              orgId={orgId}
              hasAvatar={org.organization.avatarUrl !== null}
              onChanged={() => void mutate((k) => isOrgKey(orgId, k) || k === orgKeys.mine())}
            />
            <div className="space-y-1.5">
              <Label htmlFor="org-general-slug">URL name</Label>
              <Input id="org-general-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={48} />
              <p className="text-xs text-muted-foreground">Lowercase letters, digits and hyphens.</p>
            </div>
            <Button type="submit" disabled={!dirty || saving}>Save</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Owner</CardTitle>
          <CardDescription>
            {owner ? `${owner.name || owner.email} owns ${org.organization.name}.` : 'Loading…'} The Owner can transfer ownership or delete the organization from the Danger Zone.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

export default function OrgGeneralPage() {
  return (
    <OrgSettingsShell title="General" wide={false} description={(orgName) => `Name, avatar, URL, and who owns ${orgName}.`}>
      {(ctx) => <GeneralBody {...ctx} />}
    </OrgSettingsShell>
  );
}
