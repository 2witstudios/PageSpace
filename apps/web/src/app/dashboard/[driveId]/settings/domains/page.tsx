'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, Shield, Globe, Trash2, Plus, RefreshCw, CheckCircle2, XCircle, Lock, Loader2, Star, Image as ImageIcon } from 'lucide-react';
import Link from 'next/link';
import { useDriveStore } from '@/hooks/useDrive';
import { toast } from 'sonner';
import { fetchWithAuth, del, patch } from '@/lib/auth/auth-fetch';
import useSWR from 'swr';
import { normalizeHostname, validateCustomDomain, buildDnsInstructions } from '@pagespace/lib/validators/custom-domain';
import { selectPrimaryActiveDomain } from '@pagespace/lib/canvas/primary-host';

interface CustomDomain {
  id: string;
  driveId: string;
  hostname: string;
  status: 'pending' | 'verified' | 'failed' | 'dns_failed' | 'provisioning' | 'active' | 'cert_failed';
  isPrimary: boolean;
  createdAt: string;
}

interface DomainsResponse {
  domains: CustomDomain[];
  /** Maximum custom domains allowed by the drive owner's plan (0 = not available). */
  limit: number;
}

interface SubdomainResponse {
  subdomain: string | null;
  canChange: boolean;
}

const fetcher = (url: string) => fetchWithAuth(url).then((r) => r.json());

export default function DomainsSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const updateDriveInStore = useDriveStore((state) => state.updateDrive);

  const [ogImage, setOgImage] = useState('');
  const [isSavingOgImage, setIsSavingOgImage] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [isAddingDomain, setIsAddingDomain] = useState(false);
  const [removingDomainId, setRemovingDomainId] = useState<string | null>(null);
  const [verifyingDomainId, setVerifyingDomainId] = useState<string | null>(null);
  const [verifyReasons, setVerifyReasons] = useState<Record<string, string | undefined>>({});
  const [refreshingCertId, setRefreshingCertId] = useState<string | null>(null);
  const [settingPrimaryId, setSettingPrimaryId] = useState<string | null>(null);
  const [subdomainInput, setSubdomainInput] = useState('');
  const [isSavingSubdomain, setIsSavingSubdomain] = useState(false);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  const canManage = drive?.isOwned || drive?.role === 'ADMIN';

  useEffect(() => {
    if (drive) setOgImage(drive.publishDefaultOgImageUrl ?? '');
  }, [drive]);

  // A corrected URL must be able to recover the preview, so clear the error flag
  // whenever the value changes (the keyed <img> below also remounts on change).
  useEffect(() => {
    setPreviewError(false);
  }, [ogImage]);

  const handleSaveOgImage = async (clear = false) => {
    if (isSavingOgImage) return;
    const next = clear ? '' : ogImage.trim();
    setIsSavingOgImage(true);
    try {
      await patch(`/api/drives/${driveId}`, { publishDefaultOgImageUrl: next });
      updateDriveInStore(driveId, { publishDefaultOgImageUrl: next || null });
      if (clear) setOgImage('');
      toast.success(clear ? 'Default share image cleared' : 'Default share image saved');
    } catch {
      toast.error('Failed to save default share image');
    } finally {
      setIsSavingOgImage(false);
    }
  };

  const { data: domainsData, mutate: mutateDomains } = useSWR<DomainsResponse>(
    drive && canManage ? `/api/drives/${driveId}/domains` : null,
    fetcher
  );

  const { data: subdomainData, mutate: mutateSubdomain } = useSWR<SubdomainResponse>(
    drive && canManage ? `/api/drives/${driveId}/subdomain` : null,
    fetcher
  );

  useEffect(() => {
    if (subdomainData?.subdomain) setSubdomainInput(subdomainData.subdomain);
  }, [subdomainData?.subdomain]);

  const handleChangeSubdomain = async () => {
    const trimmed = subdomainInput.trim().toLowerCase();
    if (!trimmed || isSavingSubdomain) return;
    if (trimmed === subdomainData?.subdomain) return;
    setIsSavingSubdomain(true);
    try {
      const res = await fetchWithAuth(`/api/drives/${driveId}/subdomain`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: trimmed }),
      });
      const data = await res.json().catch(() => ({})) as { subdomain?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to update subdomain');
        return;
      }
      await mutateSubdomain();
      toast.success('Subdomain updated');
    } catch {
      toast.error('Failed to update subdomain');
    } finally {
      setIsSavingSubdomain(false);
    }
  };

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
        } else if (res.status === 403) {
          toast.error(data.error ?? 'Custom domains are not available on your current plan');
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
      } else if (data.status === 'cert_failed') {
        toast.error('SSL provisioning failed — click Retry SSL to try again');
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

  const handleSetPrimary = async (domainId: string) => {
    if (settingPrimaryId) return;
    setSettingPrimaryId(domainId);
    try {
      const res = await fetchWithAuth(`/api/drives/${driveId}/domains/${domainId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPrimary: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        toast.error(data.error ?? 'Failed to set primary domain');
        return;
      }
      await mutateDomains();
      toast.success('Primary domain updated');
    } catch {
      toast.error('Failed to set primary domain');
    } finally {
      setSettingPrimaryId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl space-y-6">
        <Skeleton className="h-8 w-48" />
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
        <h1 className="text-3xl font-bold mb-1">Domains &amp; Publishing</h1>
        <p className="text-muted-foreground">Custom domains and share defaults for this drive&apos;s published canvas site</p>
      </div>

      <SubdomainCard
        subdomain={subdomainData?.subdomain ?? null}
        canChange={subdomainData?.canChange ?? false}
        inputValue={subdomainInput}
        onInputChange={setSubdomainInput}
        onSave={handleChangeSubdomain}
        isSaving={isSavingSubdomain}
      />

      <CustomDomainsCard
        domains={domainsData?.domains ?? []}
        limit={domainsData?.limit ?? null}
        newDomain={newDomain}
        onNewDomainChange={setNewDomain}
        onAdd={handleAddDomain}
        onRemove={handleRemoveDomain}
        onVerify={handleVerifyDomain}
        onRefreshCert={handleRefreshCert}
        onSetPrimary={handleSetPrimary}
        isAdding={isAddingDomain}
        removingId={removingDomainId}
        verifyingId={verifyingDomainId}
        refreshingCertId={refreshingCertId}
        settingPrimaryId={settingPrimaryId}
        verifyReasons={verifyReasons}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            Default Share Image
          </CardTitle>
          <CardDescription>
            The Open Graph image used when a published page has no image of its own. Recommended 1200×630.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="default-og-image">Image URL</Label>
            <Input
              id="default-og-image"
              type="url"
              value={ogImage}
              onChange={(e) => setOgImage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveOgImage()}
              placeholder="https://…"
            />
          </div>
          {ogImage.trim() && !previewError && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={ogImage.trim()}
              src={ogImage.trim()}
              alt="Default share image preview"
              className="max-h-40 w-full rounded-md border object-contain bg-muted"
              onError={() => setPreviewError(true)}
            />
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => handleSaveOgImage()}
              disabled={isSavingOgImage || ogImage.trim() === (drive.publishDefaultOgImageUrl ?? '')}
            >
              {isSavingOgImage && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
            <Button
              variant="outline"
              onClick={() => handleSaveOgImage(true)}
              disabled={isSavingOgImage || !(drive.publishDefaultOgImageUrl ?? '')}
            >
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Subdomain Card ──────────────────────────────────────────────────────────

interface SubdomainCardProps {
  subdomain: string | null;
  canChange: boolean;
  inputValue: string;
  onInputChange: (v: string) => void;
  onSave: () => void;
  isSaving: boolean;
}

function SubdomainCard({ subdomain, canChange, inputValue, onInputChange, onSave, isSaving }: SubdomainCardProps) {
  const preview = inputValue.trim().toLowerCase() || subdomain || 'your-subdomain';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" />
          Subdomain
        </CardTitle>
        <CardDescription>
          Your published site URL on pagespace.site
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {subdomain && (
          <a
            href={`https://${subdomain}.pagespace.site`}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-sm text-blue-500 hover:underline"
          >
            {subdomain}.pagespace.site
          </a>
        )}
        {canChange ? (
          <>
            <div className="flex gap-2 items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="subdomain-input">Custom subdomain</Label>
                <div className="flex items-center">
                  <Input
                    id="subdomain-input"
                    value={inputValue}
                    onChange={(e) => onInputChange(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !isSaving && inputValue.trim().toLowerCase() !== subdomain && onSave()}
                    placeholder="my-brand"
                    className="rounded-r-none"
                    disabled={isSaving}
                  />
                  <span className="inline-flex items-center px-3 h-9 rounded-r-md border border-l-0 bg-muted text-sm text-muted-foreground">
                    .pagespace.site
                  </span>
                </div>
              </div>
              <Button
                onClick={onSave}
                disabled={isSaving || !inputValue.trim() || inputValue.trim().toLowerCase() === subdomain}
              >
                {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Preview: https://{preview}.pagespace.site
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Custom subdomain selection is a Pro feature. <Link href="/settings/billing" className="text-blue-500 hover:underline">Upgrade</Link> to choose your own subdomain.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Custom Domains Card ───────────────────────────────────────────────────────

interface CustomDomainsCardProps {
  domains: CustomDomain[];
  /** null = still loading; 0 = not available on plan; N = max allowed */
  limit: number | null;
  newDomain: string;
  onNewDomainChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onVerify: (id: string) => void;
  onRefreshCert: (id: string) => void;
  onSetPrimary: (id: string) => void;
  isAdding: boolean;
  removingId: string | null;
  verifyingId: string | null;
  refreshingCertId: string | null;
  settingPrimaryId: string | null;
  verifyReasons: Record<string, string | undefined>;
}

const EDGE_IPV4 = process.env.NEXT_PUBLIC_PUBLISH_EDGE_IPV4 ?? '';
const EDGE_IPV6 = process.env.NEXT_PUBLIC_PUBLISH_EDGE_IPV6 ?? '';
const CNAME_TARGET = process.env.NEXT_PUBLIC_PUBLISH_EDGE_CNAME_TARGET ?? '';

function CustomDomainsCard({ domains, limit, newDomain, onNewDomainChange, onAdd, onRemove, onVerify, onRefreshCert, onSetPrimary, isAdding, removingId, verifyingId, refreshingCertId, settingPrimaryId, verifyReasons }: CustomDomainsCardProps) {
  const atCap = limit !== null && limit > 0 && domains.length >= limit;
  const notAvailable = limit === 0;
  const addDisabled = isAdding || !newDomain.trim() || atCap || notAvailable;
  // "Make primary" only matters once there's a choice to make between domains.
  const showPrimaryControls = domains.length > 1;
  // Any in-flight mutation (add/verify/cert/primary/remove) locks every per-row
  // action so concurrent requests can't race or produce stale toasts.
  const anyBusy =
    removingId !== null || verifyingId !== null || refreshingCertId !== null || settingPrimaryId !== null;
  // The EFFECTIVE primary is what the published site actually serves — an
  // explicitly-flagged active domain, else the earliest-created active one. Badge
  // and "Make primary" key off this (not the raw `isPrimary` flag) so a migrated
  // drive with no explicit primary still highlights its canonical domain, and a
  // flagged-but-inactive row is never shown as primary. Same resolver the server
  // uses. Memoized: the controlled add-domain input re-renders this card per
  // keystroke, and this filters/maps/sorts the domain list.
  const effectivePrimaryId = useMemo(
    () =>
      selectPrimaryActiveDomain(
        domains
          .filter((d) => d.status === 'active')
          .map((d) => ({ id: d.id, hostname: d.hostname, createdAt: new Date(d.createdAt), isPrimary: d.isPrimary })),
      )?.id ?? null,
    [domains],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Custom Domains
            </CardTitle>
            <CardDescription>
              Point your own domain at this drive&apos;s published canvas site
            </CardDescription>
          </div>
          {limit !== null && limit > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums mt-1">
              {domains.length} / {limit}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {notAvailable ? (
          <p className="text-sm text-muted-foreground">
            Custom domains are not available on your current plan. Upgrade to Pro or higher to add a custom domain.
          </p>
        ) : (
          <div className="flex gap-2">
            <Label htmlFor="new-custom-domain" className="sr-only">Custom domain</Label>
            <Input
              id="new-custom-domain"
              placeholder="e.g. docs.acme.com or acme.com"
              value={newDomain}
              onChange={(e) => onNewDomainChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !addDisabled && onAdd()}
              className="flex-1"
              disabled={atCap}
            />
            <Button onClick={onAdd} disabled={addDisabled}>
              {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add
            </Button>
          </div>
        )}

        {atCap && !notAvailable && (
          <p className="text-xs text-muted-foreground">
            Domain limit reached ({domains.length} / {limit}). Remove a domain to add another, or upgrade your plan.
          </p>
        )}

        {showPrimaryControls && (
          <p className="text-xs text-muted-foreground">
            The primary domain is used as the canonical address for SEO and is the link shown on your published Canvas pages.
          </p>
        )}

        {domains.length > 0 ? (
          <div className="space-y-3">
            {domains.map((domain) => (
              <DomainRow
                key={domain.id}
                domain={domain}
                onRemove={onRemove}
                onVerify={onVerify}
                onRefreshCert={onRefreshCert}
                onSetPrimary={onSetPrimary}
                showPrimaryControls={showPrimaryControls}
                isEffectivePrimary={domain.id === effectivePrimaryId}
                isRemoving={removingId === domain.id}
                isVerifying={verifyingId === domain.id}
                isRefreshingCert={refreshingCertId === domain.id}
                isSettingPrimary={settingPrimaryId === domain.id}
                anyBusy={anyBusy}
                verifyReason={verifyReasons[domain.id]}
              />
            ))}
          </div>
        ) : (
          !notAvailable && <p className="text-sm text-muted-foreground">No custom domains yet</p>
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
  onSetPrimary,
  showPrimaryControls,
  isEffectivePrimary,
  isRemoving,
  isVerifying,
  isRefreshingCert,
  isSettingPrimary,
  anyBusy,
  verifyReason,
}: {
  domain: CustomDomain;
  onRemove: (id: string) => void;
  onVerify: (id: string) => void;
  onRefreshCert: (id: string) => void;
  onSetPrimary: (id: string) => void;
  showPrimaryControls: boolean;
  isEffectivePrimary: boolean;
  isRemoving: boolean;
  isVerifying: boolean;
  isRefreshingCert: boolean;
  isSettingPrimary: boolean;
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
    if (domain.status === 'dns_failed') {
      return (
        <Badge variant="secondary" className="text-xs text-destructive gap-1">
          <XCircle className="h-3 w-3" />
          DNS Failed
        </Badge>
      );
    }
    if (domain.status === 'cert_failed') {
      return (
        <Badge variant="secondary" className="text-xs text-orange-600 gap-1">
          <XCircle className="h-3 w-3" />
          SSL Failed
        </Badge>
      );
    }
    if (domain.status === 'failed') {
      return (
        <Badge variant="secondary" className="text-xs text-destructive gap-1">
          <XCircle className="h-3 w-3" />
          DNS Failed
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" className="text-xs">
        Pending DNS
      </Badge>
    );
  };

  const showVerifyButton = domain.status === 'pending' || domain.status === 'failed' || domain.status === 'dns_failed';
  const showCertButton = domain.status === 'verified' || domain.status === 'provisioning' || domain.status === 'cert_failed';

  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Globe className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <span className="text-sm font-medium truncate">{domain.hostname}</span>
          {statusBadge()}
          {showPrimaryControls && isEffectivePrimary && (
            <Badge variant="secondary" className="text-xs gap-1">
              <Star className="h-3 w-3 fill-current" />
              Primary
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {showPrimaryControls && domain.status === 'active' && !isEffectivePrimary && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => onSetPrimary(domain.id)}
              disabled={anyBusy}
              aria-label={`Make ${domain.hostname} the primary domain`}
            >
              {isSettingPrimary ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Star className="h-3 w-3 mr-1" />
              )}
              Make primary
            </Button>
          )}
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
              {(domain.status === 'failed' || domain.status === 'dns_failed') ? 'Re-check DNS' : 'Verify DNS'}
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
              {domain.status === 'provisioning' ? 'Check SSL' : domain.status === 'cert_failed' ? 'Retry SSL' : 'Provision SSL'}
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
            disabled={anyBusy}
            aria-label={`Remove domain ${domain.hostname}`}
          >
            {isRemoving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      {(domain.status === 'failed' || domain.status === 'dns_failed') && verifyReason && (
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
