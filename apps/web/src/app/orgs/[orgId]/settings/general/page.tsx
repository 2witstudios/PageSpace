'use client';

import { useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useOrgAdminRead } from '@/hooks/useOrgs';
import { useEditingStore } from '@/stores/useEditingStore';
import { OrgMark } from '@/components/orgs/OrgMark';
import { OrgSettingsShell, type OrgSettingsContext } from '@/components/orgs/OrgSettingsShell';
import { isOrgKey, orgKeys, updateOrganization, type OrgMember } from '@/lib/orgs/org-api';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { isValidOrgSlug } from '@/lib/orgs/org-slug';

const EDITING_ID = 'org-general';

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
      await updateOrganization(orgId, body);
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
          <CardTitle>Name and URL</CardTitle>
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
    <OrgSettingsShell title="General" wide={false} description={(orgName) => `Name, URL, and who owns ${orgName}.`}>
      {(ctx) => <GeneralBody {...ctx} />}
    </OrgSettingsShell>
  );
}
