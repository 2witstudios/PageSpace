'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, Shield, Users, Bot, Plug2, Loader2, Home, Globe, Trash2, Plus, RefreshCw, CheckCircle2, XCircle, Lock } from 'lucide-react';
import Link from 'next/link';
import { useDriveStore } from '@/hooks/useDrive';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { useEditingStore } from '@/stores/useEditingStore';
import { toast } from 'sonner';
import { fetchWithAuth, patch, del } from '@/lib/auth/auth-fetch';
import useSWR from 'swr';
import { normalizeHostname, validateCustomDomain, buildDnsInstructions } from '@pagespace/lib/validators/custom-domain';

interface DriveMember {
  id: string;
  userId: string;
  user: { id: string; email: string; name?: string };
  profile?: { username?: string; avatar?: string | null };
}

interface MembersResponse {
  members: DriveMember[];
}

interface AgentMembersResponse {
  agentMembers: { id: string }[];
}

interface AppMembersResponse {
  appMembers: { id: string }[];
}

interface CustomDomain {
  id: string;
  driveId: string;
  hostname: string;
  status: 'pending' | 'verified' | 'failed' | 'provisioning' | 'active';
  createdAt: string;
}

interface DomainsResponse {
  domains: CustomDomain[];
}

const fetcher = (url: string) => fetchWithAuth(url).then((r) => r.json());

export default function GeneralSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const updateDriveInStore = useDriveStore((state) => state.updateDrive);
  const { tree } = usePageTree(driveId);

  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isClearingHomePage, setIsClearingHomePage] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [isAddingDomain, setIsAddingDomain] = useState(false);
  const [removingDomainId, setRemovingDomainId] = useState<string | null>(null);
  const [verifyingDomainId, setVerifyingDomainId] = useState<string | null>(null);
  const [verifyReasons, setVerifyReasons] = useState<Record<string, string | undefined>>({});
  const [refreshingCertId, setRefreshingCertId] = useState<string | null>(null);
  const startEditing = useEditingStore((s) => s.startEditing);
  const endEditing = useEditingStore((s) => s.endEditing);

  useEffect(() => {
    return () => endEditing('drive-settings-rename');
  }, [endEditing]);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  const canManage = drive?.isOwned || drive?.role === 'ADMIN';

  useEffect(() => {
    if (drive && !useEditingStore.getState().isAnyEditing()) setName(drive.name);
  }, [drive]);

  const { data: membersData } = useSWR<MembersResponse>(
    drive ? `/api/drives/${driveId}/members` : null,
    fetcher
  );
  const { data: agentMembersData } = useSWR<AgentMembersResponse>(
    drive ? `/api/drives/${driveId}/agents/members` : null,
    fetcher
  );
  const { data: appMembersData } = useSWR<AppMembersResponse>(
    drive ? `/api/drives/${driveId}/apps/members` : null,
    fetcher
  );
  const { data: domainsData, mutate: mutateDomains } = useSWR<DomainsResponse>(
    drive && canManage ? `/api/drives/${driveId}/domains` : null,
    fetcher
  );

  const homePageId = drive?.homePageId ?? null;
  // Memoized: the controlled name input re-renders this page per keystroke,
  // and findNodeAndParent is a full tree walk.
  const homePageNode = useMemo(
    () => (homePageId ? findNodeAndParent(tree, homePageId)?.node ?? null : null),
    [tree, homePageId]
  );

  const handleAddDomain = async () => {
    const hostname = normalizeHostname(newDomain.trim());
    const validation = validateCustomDomain(hostname);
    if (!validation.valid) {
      toast.error(validation.reason);
      return;
    }
    if (isAddingDomain) return;
    setIsAddingDomain(true);
    try {
      const res = await fetchWithAuth(`/api/drives/${driveId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        if (res.status === 409) {
          toast.error('That domain is already registered');
        } else {
          toast.error(data.error ?? 'Failed to add domain');
        }
        return;
      }
      setNewDomain('');
      await mutateDomains();
      toast.success('Domain added — set the DNS records below to activate it');
    } catch {
      toast.error('Failed to add domain');
    } finally {
      setIsAddingDomain(false);
    }
  };

  const handleVerifyDomain = async (domainId: string) => {
    if (verifyingDomainId) return;
    setVerifyingDomainId(domainId);
    try {
      const res = await fetchWithAuth(`/api/drives/${driveId}/domains/${domainId}/verify`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({})) as { verified?: boolean; reason?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Verification failed');
        return;
      }
      setVerifyReasons((prev) => ({ ...prev, [domainId]: data.reason }));
      await mutateDomains();
      if (data.verified) {
        toast.success('Domain verified — provisioning SSL cert…');
        await handleRefreshCert(domainId);
      } else {
        toast.error(data.reason ?? 'DNS records not yet propagated');
      }
    } catch {
      toast.error('Failed to verify domain');
    } finally {
      setVerifyingDomainId(null);
    }
  };

  const handleRefreshCert = async (domainId: string) => {
    if (refreshingCertId) return;
    setRefreshingCertId(domainId);
    try {
      const res = await fetchWithAuth(`/api/drives/${driveId}/domains/${domainId}/cert/refresh`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({})) as { status?: string; error?: string };
      if (!res.ok) {
        if (res.status === 503) {
          toast.error('SSL provisioning is not yet configured');
        } else {
          toast.error(data.error ?? 'Failed to refresh cert status');
        }
        return;
      }
      await mutateDomains();
      if (data.status === 'active') {
        toast.success('SSL certificate is active');
      } else if (data.status === 'provisioning') {
        toast.success('SSL cert provisioned — check back in a few minutes');
      } else if (data.status === 'failed') {
        toast.error('SSL provisioning failed — re-verify DNS or try again');
      }
    } catch {
      toast.error('Failed to refresh cert status');
    } finally {
      setRefreshingCertId(null);
    }
  };

  const handleRemoveDomain = async (domainId: string) => {
    if (removingDomainId) return;
    setRemovingDomainId(domainId);
    try {
      await del(`/api/drives/${driveId}/domains/${domainId}`);
      await mutateDomains();
      toast.success('Domain removed');
    } catch {
      toast.error('Failed to remove domain');
    } finally {
      setRemovingDomainId(null);
    }
  };

  const handleClearHomePage = async () => {
    if (isClearingHomePage) return;
    setIsClearingHomePage(true);
    try {
      await patch(`/api/drives/${driveId}`, { homePageId: null });
      updateDriveInStore(driveId, { homePageId: null });
      toast.success('Home page cleared');
    } catch {
      toast.error('Failed to clear home page');
    } finally {
      setIsClearingHomePage(false);
    }
  };

  const handleSave = async () => {
    const nextName = name.trim();
    if (isSaving || !nextName || nextName === drive?.name) return;
    setIsSaving(true);
    try {
      await patch(`/api/drives/${driveId}`, { name: nextName });
      await fetchDrives();
      toast.success('Drive renamed');
    } catch {
      toast.error('Failed to rename drive');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!drive || !canManage) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold mb-2">Access Denied</h2>
          <p className="text-muted-foreground">Only drive owners and admins can access settings.</p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push(`/dashboard/${driveId}`)}
          >
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  const humanCount = membersData?.members?.length ?? 0;
  const agentCount = agentMembersData?.agentMembers?.length ?? 0;
  const appCount = appMembersData?.appMembers?.length ?? 0;
  const topAvatars = (membersData?.members ?? []).slice(0, 5);

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/dashboard/${driveId}/settings`)}
          className="mb-4"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-1">General</h1>
        <p className="text-muted-foreground">Basic drive settings</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Drive Name</CardTitle>
          <CardDescription>Update the display name for this drive</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="drive-name">Name</Label>
            <Input
              id="drive-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={() => startEditing('drive-settings-rename', 'form', { componentName: 'GeneralSettingsPage' })}
              onBlur={() => endEditing('drive-settings-rename')}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="Drive name"
            />
          </div>
          <Button
            onClick={handleSave}
            disabled={isSaving || !name.trim() || name.trim() === drive.name}
          >
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Home Page</CardTitle>
          <CardDescription>The page people land on when they enter this drive</CardDescription>
        </CardHeader>
        <CardContent>
          {homePageId ? (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-sm min-w-0">
                <Home className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <Link
                  href={`/dashboard/${driveId}/${homePageId}`}
                  className="truncate font-medium hover:underline"
                >
                  {homePageNode?.title ?? 'Unknown page'}
                </Link>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearHomePage}
                disabled={isClearingHomePage}
              >
                {isClearingHomePage && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Clear
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              None — right-click a page in the sidebar to set one
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members Overview</CardTitle>
          <CardDescription>Current members of this drive</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-6">
            <div className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span>
                {humanCount} {humanCount === 1 ? 'member' : 'members'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <span>
                {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Plug2 className="h-4 w-4 text-muted-foreground" />
              <span>
                {appCount} {appCount === 1 ? 'app' : 'apps'}
              </span>
            </div>
          </div>
          {topAvatars.length > 0 && (
            <div className="flex -space-x-2">
              {topAvatars.map((m) => (
                <Avatar key={m.id} className="h-8 w-8 border-2 border-background">
                  <AvatarImage
                    src={m.profile?.avatar ?? undefined}
                    alt={m.user.name ?? m.user.email}
                  />
                  <AvatarFallback className="text-xs">
                    {(m.user.name ?? m.user.email).slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ))}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(`/dashboard/${driveId}/members`)}
          >
            Manage Members
          </Button>
        </CardContent>
      </Card>

      <CustomDomainsCard
        domains={domainsData?.domains ?? []}
        newDomain={newDomain}
        onNewDomainChange={setNewDomain}
        onAdd={handleAddDomain}
        onRemove={handleRemoveDomain}
        onVerify={handleVerifyDomain}
        onRefreshCert={handleRefreshCert}
        isAdding={isAddingDomain}
        removingId={removingDomainId}
        verifyingId={verifyingDomainId}
        refreshingCertId={refreshingCertId}
        verifyReasons={verifyReasons}
      />
    </div>
  );
}

// ── Custom Domains Card ───────────────────────────────────────────────────────

interface CustomDomainsCardProps {
  domains: CustomDomain[];
  newDomain: string;
  onNewDomainChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onVerify: (id: string) => void;
  onRefreshCert: (id: string) => void;
  isAdding: boolean;
  removingId: string | null;
  verifyingId: string | null;
  refreshingCertId: string | null;
  verifyReasons: Record<string, string | undefined>;
}

const EDGE_IPV4 = process.env.NEXT_PUBLIC_PUBLISH_EDGE_IPV4 ?? '';
const EDGE_IPV6 = process.env.NEXT_PUBLIC_PUBLISH_EDGE_IPV6 ?? '';
const CNAME_TARGET = process.env.NEXT_PUBLIC_PUBLISH_EDGE_CNAME_TARGET ?? '';

function CustomDomainsCard({ domains, newDomain, onNewDomainChange, onAdd, onRemove, onVerify, onRefreshCert, isAdding, removingId, verifyingId, refreshingCertId, verifyReasons }: CustomDomainsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" />
          Custom Domains
        </CardTitle>
        <CardDescription>
          Point your own domain at this drive&apos;s published canvas site
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Label htmlFor="new-custom-domain" className="sr-only">Custom domain</Label>
          <Input
            id="new-custom-domain"
            placeholder="e.g. docs.acme.com or acme.com"
            value={newDomain}
            onChange={(e) => onNewDomainChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAdd()}
            className="flex-1"
          />
          <Button onClick={onAdd} disabled={isAdding || !newDomain.trim()}>
            {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </Button>
        </div>

        {domains.length > 0 ? (
          <div className="space-y-3">
            {domains.map((domain) => (
              <DomainRow
                key={domain.id}
                domain={domain}
                onRemove={onRemove}
                onVerify={onVerify}
                onRefreshCert={onRefreshCert}
                isRemoving={removingId === domain.id}
                isVerifying={verifyingId === domain.id}
                isRefreshingCert={refreshingCertId === domain.id}
                anyBusy={verifyingId !== null || refreshingCertId !== null}
                verifyReason={verifyReasons[domain.id]}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No custom domains yet</p>
        )}
      </CardContent>
    </Card>
  );
}

function DomainRow({
  domain,
  onRemove,
  onVerify,
  onRefreshCert,
  isRemoving,
  isVerifying,
  isRefreshingCert,
  anyBusy,
  verifyReason,
}: {
  domain: CustomDomain;
  onRemove: (id: string) => void;
  onVerify: (id: string) => void;
  onRefreshCert: (id: string) => void;
  isRemoving: boolean;
  isVerifying: boolean;
  isRefreshingCert: boolean;
  anyBusy: boolean;
  verifyReason: string | undefined;
}) {
  const [showDns, setShowDns] = useState(false);
  const instructions = buildDnsInstructions({
    hostname: domain.hostname,
    edgeIpv4: EDGE_IPV4,
    edgeIpv6: EDGE_IPV6,
    cnameTarget: CNAME_TARGET,
  });

  const statusBadge = () => {
    if (domain.status === 'active') {
      return (
        <Badge variant="secondary" className="text-xs text-green-600 gap-1">
          <Lock className="h-3 w-3" />
          Active
        </Badge>
      );
    }
    if (domain.status === 'provisioning') {
      return (
        <Badge variant="secondary" className="text-xs gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Provisioning SSL
        </Badge>
      );
    }
    if (domain.status === 'verified') {
      return (
        <Badge variant="secondary" className="text-xs text-green-600 gap-1">
          <CheckCircle2 className="h-3 w-3" />
          DNS Verified
        </Badge>
      );
    }
    if (domain.status === 'failed') {
      return (
        <Badge variant="secondary" className="text-xs text-destructive gap-1">
          <XCircle className="h-3 w-3" />
          Failed
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" className="text-xs">
        Pending DNS
      </Badge>
    );
  };

  const showVerifyButton = domain.status === 'pending' || domain.status === 'failed';
  const showCertButton = domain.status === 'verified' || domain.status === 'provisioning';

  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Globe className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <span className="text-sm font-medium truncate">{domain.hostname}</span>
          {statusBadge()}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {showVerifyButton && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => onVerify(domain.id)}
              disabled={anyBusy}
              aria-label={`Verify domain ${domain.hostname}`}
            >
              {isVerifying ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              {domain.status === 'failed' ? 'Re-check DNS' : 'Verify DNS'}
            </Button>
          )}
          {showCertButton && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => onRefreshCert(domain.id)}
              disabled={anyBusy}
              aria-label={`Check SSL cert for ${domain.hostname}`}
            >
              {isRefreshingCert ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Lock className="h-3 w-3 mr-1" />
              )}
              {domain.status === 'provisioning' ? 'Check SSL' : 'Provision SSL'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            onClick={() => setShowDns((p) => !p)}
          >
            {showDns ? 'Hide DNS' : 'Show DNS'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={() => onRemove(domain.id)}
            disabled={isRemoving}
            aria-label={`Remove domain ${domain.hostname}`}
          >
            {isRemoving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      {domain.status === 'failed' && verifyReason && (
        <p className="text-xs text-destructive bg-destructive/5 rounded px-2 py-1">{verifyReason}</p>
      )}

      {showDns && (
        <div className="bg-muted rounded p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {instructions.isApex
              ? 'Add these records at your DNS provider:'
              : 'Add this record at your DNS provider:'}
          </p>
          <div className="space-y-1">
            {instructions.records.map((r, i) => (
              <div key={i} className="flex gap-3 text-xs font-mono">
                <span className="w-12 text-muted-foreground">{r.type}</span>
                <span className="w-8 text-muted-foreground">{r.name}</span>
                <span className="break-all">{r.value}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Once records propagate, click Verify DNS to confirm setup and automatically provision SSL.
          </p>
        </div>
      )}
    </div>
  );
}
